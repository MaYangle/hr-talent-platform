import base64
import http.cookiejar
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path

from talent_hub.config import Settings
from talent_hub.runtime import Application

TEST_PASSWORD = "temporary-unit-test-password"


class Client:
    def __init__(self, base_url):
        self.base_url = base_url
        self.csrf = ""
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

    def request(self, path, data=None, *, csrf=True, headers=None):
        request_headers = {"Origin": self.base_url, "Content-Type": "application/json"}
        if csrf:
            request_headers["X-CSRF-Token"] = self.csrf
        request_headers.update(headers or {})
        request = urllib.request.Request(
            self.base_url + path,
            data=None if data is None else json.dumps(data).encode(),
            headers=request_headers,
        )
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            value = (
                json.loads(raw)
                if response.headers.get_content_type() == "application/json"
                else raw
            )
            if isinstance(value, dict) and value.get("csrf"):
                self.csrf = value["csrf"]
            return response.status if hasattr(response, "status") else response.code, value

    def api(self, path, data=None, **kwargs):
        return self.request("/api/" + path, data, **kwargs)


class ApplicationTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="talent-unit-")
        settings = replace(Settings.from_env({}), data_dir=Path(self.directory.name))
        self.app = Application(settings, address=("127.0.0.1", 0))
        self.thread = threading.Thread(
            target=self.app.http.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.app.http.server_port}"
        self.client = Client(self.url)
        status, self.auth = self.client.api(
            "setup", {"username": "owner", "name": "Owner", "password": TEST_PASSWORD}
        )
        self.assertEqual(status, 200, self.auth)
        self.owner = self.auth["user"]

    def tearDown(self):
        self.app.http.shutdown()
        self.thread.join(2)
        self.app.close()
        self.directory.cleanup()

    def user(self, username, role):
        status, result = self.client.api(
            "admin/user",
            {"username": username, "name": username, "role": role, "password": TEST_PASSWORD},
        )
        self.assertEqual(status, 200, result)
        client = Client(self.url)
        status, result = client.api("login", {"username": username, "password": TEST_PASSWORD})
        self.assertEqual(status, 200, result)
        return client, result["user"]

    def candidate(self, *, complete=False, **changes):
        # Minimal field values are created only in a TemporaryDirectory, never seeded into the app.
        data = {"name": "record"}
        if complete:
            data.update(
                phone="+86 139-0000-0000",
                email="record@example.invalid",
                city="city",
                targetCity="city",
                targetRole="role",
                years="5",
                education="degree",
                english="basic",
                employment="未任职",
                skills="SQL",
                text="SQL",
                verified=True,
            )
        status, candidate = self.client.api("candidate", data | changes)
        self.assertEqual(status, 200, candidate)
        return candidate

    def job(self, **changes):
        data = {
            "title": "role",
            "text": "SQL",
            "criteria": [{"kind": "skill", "value": "SQL", "hard": True, "weight": 100}],
        }
        status, job = self.client.api("job", data | changes)
        self.assertEqual(status, 200, job)
        return job

    def upload(self, content=b"Skills: SQL", name="input.txt", **kwargs):
        data = {"files": [{"name": name, "base64": base64.b64encode(content).decode()}]} | kwargs
        return self.client.api("upload", data)

    def wait_record(self, kind, id):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            with self.app.service.store.connect() as db:
                value = self.app.service.store.get(db, kind, id)
            if value["state"] not in ["queued", "running"]:
                return value
            time.sleep(0.03)
        self.fail(f"{kind} did not finish within the test deadline")
