import socket
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from talent_hub.config import Settings
from talent_hub.locking import WorkspaceInUseError, WorkspaceLock
from talent_hub.runtime import Application
from talent_hub.store import Conflict, Store, password_hash, password_ok


class ConfigurationTests(unittest.TestCase):
    def test_bad_settings_fail_before_startup(self):
        for env in [
            {"TALENT_PORT": "text"},
            {"TALENT_PORT": "0"},
            {"TALENT_ALLOWED_HOSTS": "https://host.invalid"},
            {"TALENT_SESSION_HOURS": "200"},
            {"TALENT_SECURE_COOKIE": "yes"},
        ]:
            with self.subTest(env=env), self.assertRaises(ValueError):
                Settings.from_env(env)

    def test_defaults_and_custom_limits_are_consistent(self):
        value = Settings.from_env(
            {
                "TALENT_PORT": "9000",
                "TALENT_MAX_UPLOAD_MIB": "3",
                "TALENT_ALLOWED_HOSTS": "host.invalid, 127.0.0.2",
            }
        )
        self.assertEqual(value.port, 9000)
        self.assertEqual(value.max_upload_bytes, 3 * 1024 * 1024)
        self.assertIn("host.invalid", value.allowed_hosts)
        self.assertIn("localhost", value.allowed_hosts)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="talent-store-")
        self.root = Path(self.directory.name)
        self.store = Store(self.root)

    def tearDown(self):
        self.directory.cleanup()

    def test_new_workspace_contains_no_business_or_user_records(self):
        with self.store.connect() as db:
            self.assertEqual(self.store.all(db, "candidates"), [])
            self.assertEqual(self.store.all(db, "jobs"), [])
            self.assertEqual(self.store.users(db), [])

    def test_conflicting_update_preserves_first_writer(self):
        with self.store.tx() as db:
            original = self.store.put(db, "candidates", {"name": "original"})
        with self.store.tx() as db:
            self.store.put(db, "candidates", original | {"name": "first"}, original["rev"])
        with self.assertRaises(Conflict), self.store.tx() as db:
            self.store.put(db, "candidates", original | {"name": "second"}, original["rev"])
        with self.store.connect() as db:
            self.assertEqual(self.store.get(db, "candidates", original["id"])["name"], "first")

    def test_failed_transaction_rolls_back(self):
        with self.assertRaises(RuntimeError), self.store.tx() as db:
            self.store.put(db, "candidates", {"name": "not committed"})
            raise RuntimeError("rollback")
        with self.store.connect() as db:
            self.assertEqual(self.store.all(db, "candidates"), [])

    def test_restart_requeues_only_running_tasks_and_preserves_results(self):
        with self.store.tx() as db:
            run = self.store.put(db, "runs", {"state": "running", "items": [{"result": "saved"}]})
            finished = self.store.put(db, "runs", {"state": "done", "items": []})
        recovered = Store(self.root)
        with recovered.connect() as db:
            self.assertEqual(recovered.get(db, "runs", run["id"])["state"], "queued")
            self.assertEqual(recovered.get(db, "runs", run["id"])["items"], [{"result": "saved"}])
            self.assertEqual(recovered.get(db, "runs", finished["id"])["state"], "done")

    def test_second_process_lock_is_rejected_until_release(self):
        with WorkspaceLock(self.root):
            with self.assertRaises(WorkspaceInUseError):
                WorkspaceLock(self.root).acquire()
        with WorkspaceLock(self.root):
            pass

    def test_occupied_port_does_not_start_a_worker(self):
        settings = replace(Settings.from_env({}), data_dir=self.root)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with patch("talent_hub.runtime.Service.start_worker") as start:
                with self.assertRaises(OSError):
                    Application(settings, address=listener.getsockname())
                start.assert_not_called()
        with WorkspaceLock(self.root):
            pass

    def test_password_hashes_use_distinct_salts(self):
        first = password_hash("only-a-unit-test-password")
        second = password_hash("only-a-unit-test-password")
        self.assertNotEqual(first, second)
        self.assertTrue(password_ok("only-a-unit-test-password", first))
        self.assertFalse(password_ok("different-password", first))
