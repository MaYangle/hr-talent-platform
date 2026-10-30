import copy
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

from talent_hub.service import Service
from talent_hub.store import Store
from tests.support import TEST_PASSWORD, ApplicationTestCase, Client


class AuthenticationTests(ApplicationTestCase):
    def test_bootstrap_is_empty_and_has_no_reusable_setup_endpoint(self):
        status, result = self.client.api("boot")
        self.assertEqual(status, 200)
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["jobs"], [])
        self.assertEqual(
            self.client.api("setup", {"username": "second", "password": TEST_PASSWORD})[0], 409
        )

    def test_anonymous_and_cross_origin_access_are_rejected(self):
        self.assertEqual(Client(self.url).api("boot")[0], 401)
        self.assertEqual(self.client.api("candidate", {"name": "entry"}, csrf=False)[0], 403)
        self.assertEqual(
            self.client.api("candidate", {}, headers={"Origin": "https://other.invalid"})[0], 403
        )
        self.assertEqual(self.client.api("boot", headers={"Host": "other.invalid"})[0], 403)

    def test_private_source_and_malformed_attachment_routes_are_not_served(self):
        self.assertEqual(self.client.request("/server.py")[0], 404)
        self.assertEqual(self.client.request("/talent_hub/store.py")[0], 404)
        self.assertEqual(self.client.api("file/resume")[0], 400)

    def test_login_rate_limit_and_logout(self):
        anonymous = Client(self.url)
        for _ in range(5):
            self.assertEqual(
                anonymous.api("login", {"username": "owner", "password": "incorrect"})[0], 401
            )
        self.assertEqual(
            anonymous.api("login", {"username": "owner", "password": TEST_PASSWORD})[0], 429
        )
        self.assertEqual(self.client.api("logout", {})[0], 200)
        self.assertEqual(self.client.api("boot")[0], 401)

    def test_non_admin_roles_cannot_change_settings_or_download_backups(self):
        hr, _ = self.user("hr", "HR")
        manager, _ = self.user("manager", "招聘经理")
        self.assertEqual(hr.api("backup")[0], 403)
        self.assertEqual(hr.api("admin/config", {})[0], 403)
        self.assertEqual(manager.api("export", {})[0], 403)
        record = self.candidate(complete=True, monthly="10-20")
        value = manager.api("detail/candidate/" + record["id"])[1]
        for key in ["phone", "email", "monthly", "text"]:
            self.assertNotIn(key, value)

    def test_password_change_invalidates_all_existing_sessions(self):
        second = Client(self.url)
        self.assertEqual(
            second.api("login", {"username": "owner", "password": TEST_PASSWORD})[0], 200
        )
        self.assertEqual(
            self.client.api(
                "password", {"old": TEST_PASSWORD, "password": "replacement-unit-test-password"}
            )[0],
            200,
        )
        self.assertEqual(second.api("boot")[0], 401)

    def test_liveness_and_worker_readiness_are_distinct(self):
        self.assertEqual(self.client.request("/health/live")[0], 200)
        self.assertEqual(self.client.request("/health/ready")[0], 200)
        self.app.service.stop.set()
        self.app.service.worker.join(2)
        self.assertEqual(self.client.request("/health/ready")[0], 503)
        self.assertEqual(self.client.request("/health/live")[0], 200)


class WorkflowTests(ApplicationTestCase):
    def test_job_rejects_an_unknown_owner_without_creating_a_version(self):
        status, _ = self.client.api(
            "job",
            {
                "title": "role",
                "text": "SQL",
                "ownerId": "absent",
                "criteria": [{"kind": "skill", "value": "SQL", "weight": 100}],
            },
        )
        self.assertEqual(status, 400)
        self.assertEqual(self.client.api("boot")[1]["jobVersions"], [])

    def application(self, candidate, job, **changes):
        data = {
            "candidateId": candidate["id"],
            "jobId": job["id"],
            "stage": "待联系",
            "ownerId": self.owner["id"],
            "nextAction": "review",
            "due": "2030-01-01T00:00:00+00:00",
        } | changes
        status, result = self.client.api("application", data)
        self.assertEqual(status, 200, result)
        return result

    def test_conflicting_candidate_edit_is_not_silently_saved(self):
        original = self.candidate()
        self.assertEqual(self.client.api("candidate", original | {"name": "first"})[0], 200)
        self.assertEqual(self.client.api("candidate", original | {"name": "second"})[0], 409)
        self.assertEqual(self.client.api("detail/candidate/" + original["id"])[1]["name"], "first")

    def test_job_versions_are_immutable_and_global_state_is_independent(self):
        candidate = self.candidate()
        job = self.job()
        self.assertEqual(
            self.client.api(
                "job",
                job
                | {
                    "text": "changed",
                    "criteria": [{"kind": "skill", "value": "Python", "weight": 100}],
                },
            )[0],
            200,
        )
        boot = self.client.api("boot")[1]
        original = next(v for v in boot["jobVersions"] if v["id"] == job["currentVersionId"])
        self.assertEqual(original["text"], "SQL")
        application = self.application(candidate, job)
        self.application(
            candidate,
            job,
            **(
                {k: v for k, v in application.items() if k not in ["candidateId", "jobId"]}
                | {"stage": "业务面试"}
            ),
        )
        self.assertEqual(
            self.client.api("detail/candidate/" + candidate["id"])[1]["status"], "新入库"
        )

    def test_pipeline_requires_owner_deadline_and_closure_result(self):
        candidate, job = self.candidate(), self.job()
        base = {"candidateId": candidate["id"], "jobId": job["id"], "ownerId": self.owner["id"]}
        self.assertEqual(self.client.api("application", base)[0], 400)
        self.assertEqual(self.client.api("application", base | {"stage": "已结束"})[0], 400)

    def test_interview_conflict_and_assigned_interviewer_scope(self):
        interviewer, user = self.user("reviewer", "面试官")
        candidate, job = self.candidate(), self.job()
        application = self.application(candidate, job)
        data = {
            "candidateId": candidate["id"],
            "jobId": job["id"],
            "applicationId": application["id"],
            "interviewerId": user["id"],
            "ownerId": self.owner["id"],
            "round": 1,
            "type": "业务面试",
            "time": "2030-01-02T00:00:00+00:00",
            "duration": 60,
            "due": "2030-01-03T00:00:00+00:00",
            "status": "已安排",
            "meetingMode": "视频",
            "meetingLocation": "https://example.invalid/meeting",
        }
        status, interview = self.client.api("interview", data)
        self.assertEqual(status, 200, interview)
        self.assertEqual(interview["meetingMode"], "视频")
        self.assertEqual(interview["meetingLocation"], data["meetingLocation"])
        self.assertEqual(self.client.api("interview", data | {"meetingMode": "invalid"})[0], 400)
        self.assertEqual(
            self.client.api("interview", data | {"time": "2030-01-02T00:30:00+00:00"})[0], 409
        )
        self.candidate(name="unassigned")
        scoped = interviewer.api("boot")[1]
        self.assertEqual([c["id"] for c in scoped["candidates"]], [candidate["id"]])
        self.assertEqual(
            interviewer.api(
                "interview", interview | {"status": "已完成", "score": "4", "feedback": "reviewed"}
            )[0],
            200,
        )
        latest = interviewer.api("boot")[1]["interviews"][0]
        status, protected = interviewer.api(
            "interview",
            latest | {"status": "已完成", "meetingLocation": "changed", "meetingMode": "现场"},
        )
        self.assertEqual(status, 200, protected)
        self.assertEqual(protected["meetingLocation"], data["meetingLocation"])
        self.assertEqual(protected["meetingMode"], "视频")
        self.assertEqual(
            interviewer.api(
                "interview", interview | {"time": "2030-01-04T00:00:00+00:00", "status": "已取消"}
            )[0],
            403,
        )

    def test_removed_views_and_metrics_use_actual_saved_records(self):
        record = self.candidate()
        self.application(record, self.job())
        self.assertEqual(
            self.client.api(
                "view", {"name": "queue", "shared": True, "filters": {"unverified": True}}
            )[0],
            404,
        )
        self.assertNotIn("views", self.client.api("boot")[1])
        status, metrics = self.client.api("metrics", {})
        self.assertEqual(status, 200)
        self.assertEqual(metrics["total"], 1)
        self.assertEqual(metrics["stages"][0]["current"], 1)
        self.assertEqual(sum(n for _, n in metrics["trends"]), 1)
        self.assertEqual(
            self.client.api("metrics", {"start": "2030-01-02", "end": "2030-01-01"})[0], 400
        )


class TaskTests(ApplicationTestCase):
    def test_admin_config_accepts_only_the_explicit_private_model_origin(self):
        config = self.client.api("boot")[1]["config"]
        status, saved = self.client.api(
            "admin/config",
            config
            | {
                "modelUrl": "http://172.30.0.101:20001/v1",
                "model": "Qwen/Qwen3.8-27B",
                "extractionMode": "model",
                "mode": "rules",
            },
        )
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["modelUrl"], "http://172.30.0.101:20001/v1")
        self.assertEqual(
            self.client.api(
                "admin/config",
                saved | {"modelUrl": "http://172.30.0.101:20002/v1"},
            )[0],
            400,
        )

    def test_admin_model_test_uses_unsaved_config_and_does_not_persist_it(self):
        before = self.client.api("boot")[1]["config"]
        config = {"modelUrl": "http://172.30.0.101:20001/v1", "model": "Qwen/Qwen3.8-27B"}
        with patch("talent_hub.service.probe_model") as probe:
            status, result = self.client.api("admin/model-test", config)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["model"], config["model"])
        probe.assert_called_once()
        self.assertEqual(probe.call_args.args[0], config)
        self.assertEqual(self.client.api("boot")[1]["config"], before)

    def test_admin_model_test_returns_auth_failure_without_leaking_server_body(self):
        with patch(
            "talent_hub.service.probe_model",
            side_effect=ValueError("模型服务认证失败（HTTP 401），请检查 TALENT_MODEL_API_KEY"),
        ):
            status, result = self.client.api(
                "admin/model-test",
                {"modelUrl": "http://172.30.0.101:20001/v1", "model": "Qwen/Qwen3.8-27B"},
            )
        self.assertEqual(status, 502)
        self.assertIn("HTTP 401", result["error"])
        self.assertNotIn("server body", result["error"])

    def test_model_key_is_private_preserved_and_available_to_probe(self):
        from talent_hub.credentials import read_model_key

        key = "unit-test-private-model-key"
        config = self.client.api("boot")[1]["config"]
        with patch("talent_hub.service.probe_model") as probe:
            status, result = self.client.api("admin/model-test", config | {"apiKey": key})
            self.assertEqual(status, 200, result)
            self.assertEqual(probe.call_args.args[0]["apiKey"], key)
        self.assertFalse((self.app.service.store.root / "model-key.secret").exists())
        status, saved = self.client.api("admin/config", config | {"apiKey": key})
        self.assertEqual(status, 200, saved)
        self.assertNotIn(key, str(saved))
        self.assertEqual(read_model_key(self.app.service.store.root), key)
        boot = self.client.api("boot")[1]
        self.assertTrue(boot["config"]["apiKeyConfigured"])
        self.assertNotIn(key, str(boot))
        self.assertNotIn(key, str(self.client.api("backup")[1]))
        status, saved = self.client.api("admin/config", boot["config"] | {"apiKey": ""})
        self.assertEqual(status, 200, saved)
        with patch("talent_hub.service.probe_model") as probe:
            self.assertEqual(self.client.api("admin/model-test", saved)[0], 200)
            self.assertEqual(probe.call_args.args[0]["apiKey"], key)
        hr, _ = self.user("key-test-hr", "HR")
        self.assertEqual(hr.api("admin/model-test", config | {"apiKey": key})[0], 403)
        self.assertNotIn("config", hr.api("boot")[1])

    def enable_model(self):
        config = self.client.api("boot")[1]["config"]
        status, result = self.client.api(
            "admin/config",
            config | {"extractionMode": "model", "model": "unit-protocol"},
        )
        self.assertEqual(status, 200, result)

    def enable_rules(self):
        config = self.client.api("boot")[1]["config"]
        status, result = self.client.api("admin/config", config | {"extractionMode": "rules"})
        self.assertEqual(status, 200, result)

    def test_import_model_fills_fields_before_review_without_creating_a_candidate(self):
        self.enable_model()
        evidence = {
            "name": {
                "page": 1,
                "line": 1,
                "quote": "Alex Chen | Analyst",
                "raw": "Alex Chen",
                "confirmed": False,
                "method": "model",
            }
        }
        with patch(
            "talent_hub.service.model_fields", return_value=({"name": "Alex Chen"}, evidence)
        ) as model:
            task = self.wait_record(
                "imports",
                self.upload(b"Alex Chen | Analyst\nEmail: alex@example.invalid")[1][0]["id"],
            )
        model.assert_called_once()
        self.assertEqual(task["state"], "review")
        self.assertEqual(task["fields"]["name"], "Alex Chen")
        self.assertEqual(task["fields"]["email"], "alex@example.invalid")
        self.assertEqual(task["parserMode"], "model")
        self.assertEqual(self.client.api("boot")[1]["config"]["mode"], "rules")
        self.assertEqual(task["evidence"]["name"], evidence["name"])
        self.assertEqual(self.client.api("boot")[1]["candidates"], [])
        decision = self.review(task, fields={})
        candidate = self.client.api("detail/candidate/" + decision["candidateId"])[1]
        self.assertEqual(candidate["name"], "Alex Chen")
        self.assertFalse(candidate["verified"])

    def test_import_model_failure_preserves_rules_and_original_and_can_reparse(self):
        self.enable_model()
        content = b"Name: Alex Chen\nEmail: alex@example.invalid"
        with patch("talent_hub.service.model_fields", side_effect=ValueError("offline")):
            task = self.wait_record("imports", self.upload(content)[1][0]["id"])
        self.assertEqual(task["state"], "review")
        self.assertEqual(task["fields"]["name"], "Alex Chen")
        self.assertIn("offline", task["modelWarning"])
        self.assertEqual(self.client.api("file/import/" + task["id"])[1], content)
        with patch("talent_hub.service.model_fields", return_value=({}, {})) as model:
            self.review(task, action="reparse")
            reparsed = self.wait_record("imports", task["id"])
        model.assert_called_once()
        self.assertEqual(reparsed["modelWarning"], "")
        self.assertEqual(reparsed["attempts"], 2)

    def test_rules_mode_does_not_call_model(self):
        self.enable_rules()
        with patch("talent_hub.service.model_fields") as model:
            task = self.wait_record("imports", self.upload()[1][0]["id"])
        model.assert_not_called()
        self.assertEqual(task["parserMode"], "rules")

    def test_match_model_mode_does_not_enable_resume_model_extraction(self):
        config = self.client.api("boot")[1]["config"]
        self.client.api(
            "admin/config",
            config | {"mode": "model", "extractionMode": "rules", "model": "unit-protocol"},
        )
        with patch("talent_hub.service.model_fields") as model:
            task = self.wait_record("imports", self.upload()[1][0]["id"])
        model.assert_not_called()
        self.assertEqual(task["parserMode"], "rules")
        self.assertEqual(self.client.api("boot")[1]["config"]["mode"], "model")

    def test_identical_resume_in_model_mode_is_extracted_and_still_requires_duplicate_review(self):
        first = self.wait_record("imports", self.upload()[1][0]["id"])
        decision = self.review(first)
        self.enable_model()
        with patch("talent_hub.service.model_fields", return_value=({}, {})) as model:
            duplicate = self.wait_record("imports", self.upload()[1][0]["id"])
        model.assert_called_once()
        self.assertEqual(duplicate["state"], "duplicate")
        self.assertEqual(duplicate["duplicates"][0]["id"], decision["candidateId"])

    def review(self, task, **changes):
        payload = {"rev": task["rev"], "action": "create", "fields": {"name": "record"}} | changes
        status, result = self.client.api("import/" + task["id"], payload)
        self.assertEqual(status, 200, result)
        return result

    def test_upload_request_is_idempotent_and_rejects_changed_payload(self):
        request_id = str(uuid.uuid4())
        first = self.upload(requestId=request_id)[1][0]
        second = self.upload(requestId=request_id)[1][0]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(self.upload(b"changed", requestId=request_id)[0], 409)

    def test_failed_parse_preserves_original_and_can_be_retried_or_entered_manually(self):
        content = b"%PDF-1.7\ninvalid"
        status, tasks = self.upload(content, "input.pdf")
        self.assertEqual(status, 200)
        failed = self.wait_record("imports", tasks[0]["id"])
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(self.client.api("file/import/" + failed["id"])[1], content)
        self.assertEqual(
            self.client.api("import/" + failed["id"], {"rev": failed["rev"], "action": "retry"})[0],
            200,
        )
        failed = self.wait_record("imports", failed["id"])
        self.assertEqual(failed["attempts"], 2)
        self.assertEqual(self.review(failed, action="manual")["state"], "done")

    def test_duplicate_version_does_not_overwrite_reviewed_profile(self):
        self.enable_rules()
        first = self.wait_record("imports", self.upload()[1][0]["id"])
        decision = self.review(first)
        candidate = self.client.api("detail/candidate/" + decision["candidateId"])[1]
        self.client.api("candidate", candidate | {"text": "manually reviewed"})
        duplicate = self.upload()[1][0]
        self.assertEqual(duplicate["state"], "duplicate")
        self.review(duplicate, action="link", candidateId=candidate["id"])
        after = self.client.api("detail/candidate/" + candidate["id"])[1]
        self.assertEqual(after["text"], "manually reviewed")
        self.assertEqual(len(after["resumeIds"]), 2)

    def test_partial_model_failure_can_resume_without_losing_successes(self):
        first = self.candidate(complete=True)
        self.candidate(complete=True, name="second")
        job = self.job()
        config = self.client.api("boot")[1]["config"]
        self.client.api("admin/config", config | {"mode": "model", "model": "unit-protocol"})
        with patch("talent_hub.service.model_dimensions", side_effect=[ValueError("offline"), []]):
            run = self.client.api("run", {"versionId": job["currentVersionId"]})[1]
            partial = self.wait_record("runs", run["id"])
        self.assertEqual(partial["state"], "partial")
        self.assertEqual(len(partial["items"]), 1)
        saved = copy.deepcopy(partial["items"][0])
        self.client.api("candidate", first | {"text": "later edit", "verified": True})
        with patch("talent_hub.service.model_dimensions", return_value=[]):
            self.assertEqual(self.client.api("retry-run/" + run["id"], {})[0], 200)
            complete = self.wait_record("runs", run["id"])
        self.assertEqual(complete["state"], "done")
        self.assertEqual(len(complete["items"]), 2)
        self.assertEqual(complete["items"][0], saved)
        self.assertNotEqual(complete["snapshots"][0]["candidate"]["text"], "later edit")

    def test_backup_restores_original_bytes_into_empty_directory(self):
        content = b"Skills: SQL"
        task = self.wait_record("imports", self.upload(content)[1][0]["id"])
        self.review(task)
        status, backup = self.client.api("backup")
        self.assertEqual(status, 200)
        backup["records"].append(
            {"kind": "views", "id": "retired", "rev": 1, "data": "{}"}
        )
        with tempfile.TemporaryDirectory(prefix="talent-restored-") as directory:
            service = Service(Store(directory), settings=self.app.settings)
            service.restore({"confirm": "替换工作区", "backup": backup}, self.owner)
            with service.store.connect() as db:
                resumes = service.store.all(db, "resumes")
                self.assertEqual(service.store.all(db, "views"), [])
                self.assertEqual(len(resumes), 1)
                self.assertEqual(
                    (Path(directory) / "files" / resumes[0]["fileId"]).read_bytes(), content
                )
                self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)

    def test_export_permission_is_checked_before_returning_records(self):
        self.candidate()
        manager, _ = self.user("manager", "招聘经理")
        self.assertEqual(manager.api("export", {})[0], 403)
        status, exported = self.client.api("export", {})
        self.assertEqual(status, 200)
        self.assertEqual(len(exported["candidates"]), 1)
