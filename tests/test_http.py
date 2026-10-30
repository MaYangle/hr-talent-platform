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
        }
        status, interview = self.client.api("interview", data)
        self.assertEqual(status, 200, interview)
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
        self.assertEqual(
            interviewer.api(
                "interview", interview | {"time": "2030-01-04T00:00:00+00:00", "status": "已取消"}
            )[0],
            403,
        )

    def test_views_and_metrics_use_actual_saved_records(self):
        record = self.candidate()
        self.application(record, self.job())
        self.assertEqual(
            self.client.api(
                "view", {"name": "queue", "shared": True, "filters": {"unverified": True}}
            )[0],
            200,
        )
        status, metrics = self.client.api("metrics", {})
        self.assertEqual(status, 200)
        self.assertEqual(metrics["total"], 1)
        self.assertEqual(metrics["stages"][0]["current"], 1)
        self.assertEqual(sum(n for _, n in metrics["trends"]), 1)
        self.assertEqual(
            self.client.api("metrics", {"start": "2030-01-02", "end": "2030-01-01"})[0], 400
        )


class TaskTests(ApplicationTestCase):
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
        with tempfile.TemporaryDirectory(prefix="talent-restored-") as directory:
            service = Service(Store(directory), settings=self.app.settings)
            service.restore({"confirm": "替换工作区", "backup": backup}, self.owner)
            with service.store.connect() as db:
                resumes = service.store.all(db, "resumes")
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
