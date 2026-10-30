import base64
import copy
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

from .config import Settings
from .credentials import read_model_key, save_model_key
from .domain import (
    PERMISSIONS,
    RULE_VERSION,
    STAGES,
    criteria_from_job,
    duplicate_candidates,
    missing,
    parse_fields,
    score,
    uid,
    utc,
    validate_candidate,
)
from .model import model_dimensions, model_fields, model_url_allowed, probe_model
from .parsing import extract, validate_file
from .store import Conflict, Store, password_hash, password_ok


class APIError(Exception):
    def __init__(self, message, status=400):
        self.status = status
        super().__init__(message)


class Service:
    def __init__(self, store=None, settings=None):
        self.settings = settings or Settings.from_env()
        self.store = store or Store(self.settings.data_dir)
        self.stop = threading.Event()
        self.rates = {}
        self.rate_lock = threading.Lock()

    def need(self, user, permission):
        if permission not in PERMISSIONS.get(user["role"], set()):
            raise APIError("当前账号无此权限", 403)

    def session(self, token):
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.store.connect() as db:
            r = db.execute(
                "SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1",
                (digest, time.time()),
            ).fetchone()
            if not r:
                raise APIError("请登录，或会话已过期", 401)
            user = dict(r)
            user.pop("password", None)
            return user

    def auth(self, path, data, client):
        with self.store.tx() as db:
            count = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if path == "setup":
                if count:
                    raise APIError("工作区已初始化，请登录", 409)
                if client not in ["127.0.0.1", "::1"]:
                    raise APIError("首次设置必须在服务器本机完成", 403)
                username = str(data.get("username", "")).strip()
                name = str(data.get("name", "管理员")).strip()
                if not username or len(username) > 80 or not name:
                    raise APIError("请填写账号与姓名")
                pw = password_hash(data.get("password", ""))
                id = uid()
                db.execute(
                    "INSERT INTO users VALUES(?,?,?,?,?,1)", (id, username, name, "管理员", pw)
                )
                user = {"id": id, "username": username, "name": name, "role": "管理员"}
                self.store.audit(db, user, "首次初始化工作区")
            else:
                key = (client, str(data.get("username", "")))
                with self.rate_lock:
                    attempts = [t for t in self.rates.get(key, []) if t > time.time() - 60]
                    if len(attempts) >= 5:
                        raise APIError("登录尝试过多，请一分钟后重试", 429)
                    attempts.append(time.time())
                    self.rates[key] = attempts
                row = db.execute(
                    "SELECT * FROM users WHERE username=? AND active=1", (data.get("username", ""),)
                ).fetchone()
                if not row or not password_ok(str(data.get("password", "")), row["password"]):
                    raise APIError("账号或密码不正确", 401)
                user = dict(row)
                self.store.audit(db, user, "登录工作区")
                with self.rate_lock:
                    self.rates.pop(key, None)
            token = secrets.token_urlsafe(32)
            csrf = secrets.token_urlsafe(24)
            db.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
            db.execute(
                "INSERT INTO sessions VALUES(?,?,?,?)",
                (
                    hashlib.sha256(token.encode()).hexdigest(),
                    user["id"],
                    csrf,
                    time.time() + self.settings.session_hours * 3600,
                ),
            )
            return {
                "token": token,
                "csrf": csrf,
                "user": {k: user[k] for k in ["id", "username", "name", "role"]},
            }

    def candidate_scope(self, db, user):
        cs = self.store.all(db, "candidates")
        if user["role"] == "面试官":
            ids = {
                i["candidateId"]
                for i in self.store.all(db, "interviews")
                if i.get("interviewerId") == user["id"]
            }
            cs = [c for c in cs if c["id"] in ids]
        return cs

    def check_candidate(self, db, user, id):
        if id not in {c["id"] for c in self.candidate_scope(db, user)}:
            raise APIError("记录不存在或不可访问", 404)
        return self.store.get(db, "candidates", id)

    def redact(self, c, user):
        c = copy.deepcopy(c)
        if user["role"] == "面试官":
            c.pop("legacyInterviews", None)
        if "salary" not in PERMISSIONS[user["role"]]:
            for k in [
                "monthly",
                "annual",
                "phone",
                "email",
                "phoneNormalized",
                "emailNormalized",
                "text",
                "evidence",
            ]:
                c.pop(k, None)
        return c

    def boot(self, user):
        with self.store.connect() as db:
            cs = self.candidate_scope(db, user)
            ids = {c["id"] for c in cs}
            p = PERMISSIONS[user["role"]]
            resumes = self.store.all(db, "resumes")
            for c in cs:
                c["latestResumeAt"] = max(
                    [r["created"] for r in resumes if r.get("candidateId") == c["id"]]
                    or [c["created"]]
                )
            data = {
                "user": {k: user[k] for k in ["id", "name", "username", "role"]},
                "permissions": sorted(p),
                "csrf": user["csrf"],
                "candidates": [self.redact(c, user) for c in cs],
                "users": self.store.users(db),
                "serverTime": utc(),
            }
            data["limits"] = {
                "maxUploadBytes": self.settings.max_upload_bytes,
                "maxBatchFiles": self.settings.max_batch_files,
                "sessionHours": self.settings.session_hours,
            }
            for kind in [
                "jobs",
                "jobVersions",
                "applications",
                "interviews",
                "imports",
                "runs",
                "resumes",
            ]:
                rows = self.store.all(db, kind)
                if user["role"] == "面试官":
                    assigned = [
                        i
                        for i in self.store.all(db, "interviews")
                        if i.get("interviewerId") == user["id"]
                    ]
                    jobs = {i["jobId"] for i in assigned}
                    applications = {i["applicationId"] for i in assigned}
                    if kind == "jobs":
                        rows = [r for r in rows if r["id"] in jobs]
                    if kind == "jobVersions":
                        rows = [r for r in rows if r["jobId"] in jobs]
                    if kind == "applications":
                        rows = [r for r in rows if r["id"] in applications]
                if kind in ["imports", "runs"] and "write" not in p:
                    rows = []
                if kind == "resumes":
                    rows = [r for r in rows if r.get("candidateId") in ids]
                    if "files" not in p:
                        rows = []
                    rows = [
                        {k: v for k, v in r.items() if k not in ["pages", "text", "fileId"]}
                        for r in rows
                    ]
                if kind in ["applications", "interviews"]:
                    rows = [r for r in rows if r.get("candidateId") in ids]
                if kind == "interviews" and user["role"] == "面试官":
                    rows = [r for r in rows if r.get("interviewerId") == user["id"]]
                if kind == "runs":
                    rows = [
                        {k: v for k, v in r.items() if k not in ["snapshots", "items"]}
                        | {"done": len(r.get("items", []))}
                        for r in rows
                    ]
                if kind == "imports":
                    rows = [
                        {k: v for k, v in r.items() if k not in ["pages", "fileId"]} for r in rows
                    ]
                data[kind] = rows
            if "admin" in p:
                data["config"] = self.store.get(db, "config", "system")
                data["config"]["apiKeyConfigured"] = bool(
                    (self.store.root / "model-key.secret").exists()
                    or os.environ.get("TALENT_MODEL_API_KEY")
                )
            if "audit" in p:
                data["audit"] = [
                    dict(x) for x in db.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 150")
                ]
            return data

    def detail(self, kind, id, user):
        with self.store.tx() as db:
            if kind == "candidate":
                c = self.check_candidate(db, user, id)
                self.store.audit(db, user, "查看人才档案", id)
                return self.redact(c, user)
            if kind == "resume":
                self.need(user, "files")
                r = self.store.get(db, "resumes", id)
                self.check_candidate(db, user, r["candidateId"])
                self.store.audit(db, user, "查看简历文本", id)
                return {k: v for k, v in r.items() if k != "fileId"}
            if kind == "run":
                self.need(user, "write")
                r = self.store.get(db, "runs", id)
                self.store.audit(db, user, "查看匹配快照", id)
                return r
            if kind == "import":
                self.need(user, "write")
                r = self.store.get(db, "imports", id)
                return {k: v for k, v in r.items() if k != "fileId"}
        raise APIError("接口不存在", 404)

    def save_candidate(self, data, user):
        self.need(user, "write")
        with self.store.tx() as db:
            old = self.store.get(db, "candidates", data["id"]) if data.get("id") else None
            c = validate_candidate(data, old)
            if old and old.get("status") != c["status"]:
                c.setdefault("statusHistory", []).append(
                    {"from": old["status"], "to": c["status"], "time": utc(), "actor": user["name"]}
                )
            if c.get("evidence") and data.get("verified"):
                for key, ev in c["evidence"].items():
                    ev.update(
                        confirmed=True,
                        confirmedBy=user["id"],
                        confirmedAt=utc(),
                        confirmedValue=c.get(key, ""),
                        corrected=c.get(key, "") != ev.get("raw", ""),
                    )
            c["updatedBy"] = user["id"]
            c = self.store.put(db, "candidates", c, data.get("rev"))
            self.store.audit(
                db, user, "保存并核实档案" if c["verified"] else "保存待核对档案", c["id"]
            )
            return c

    def save_job(self, data, user):
        self.need(user, "write")
        title = str(data.get("title", "")).strip()
        text = str(data.get("text", "")).strip()
        if not title or not text:
            raise APIError("岗位名称与 JD 原文必填")
        criteria = criteria_from_job(data)
        with self.store.tx() as db:
            owner_id = data.get("ownerId", user["id"])
            if owner_id not in {u["id"] for u in self.store.users(db) if u["active"]}:
                raise APIError("请选择有效岗位负责人")
            old = self.store.get(db, "jobs", data["id"]) if data.get("id") else None
            if old and old["rev"] != data.get("rev"):
                raise Conflict("岗位已更新，请刷新")
            job = old or {"id": uid(), "created": utc(), "versionIds": []}
            v = self.store.put(
                db,
                "jobVersions",
                {
                    "jobId": job["id"],
                    "number": len(job["versionIds"]) + 1,
                    "title": title,
                    "text": text,
                    "criteria": criteria,
                    "confirmed": True,
                    "created": utc(),
                    "actor": user["name"],
                    "anchors": [0, 25, 50, 75, 100],
                },
            )
            job.update(
                title=title,
                ownerId=owner_id,
                updated=utc(),
                currentVersionId=v["id"],
            )
            job["versionIds"].append(v["id"])
            job = self.store.put(db, "jobs", job, data.get("rev"))
            self.store.audit(db, user, "发布不可变 JD 版本 v" + str(v["number"]), job["id"])
            return job

    def save_application(self, data, user):
        self.need(user, "pipeline")
        with self.store.tx() as db:
            old = self.store.get(db, "applications", data["id"]) if data.get("id") else None
            c = self.check_candidate(
                db, user, data.get("candidateId") or (old or {}).get("candidateId")
            )
            job = self.store.get(db, "jobs", data.get("jobId") or (old or {}).get("jobId"))
            if not old and any(
                a["candidateId"] == c["id"] and a["jobId"] == job["id"]
                for a in self.store.all(db, "applications")
            ):
                raise APIError("该人才已加入此岗位，请编辑现有流程")
            stage = data.get("stage", "待联系")
            owner = data.get("ownerId")
            due = data.get("due", "")
            action = str(data.get("nextAction", "")).strip()
            if stage not in STAGES:
                raise APIError("岗位阶段无效")
            if owner not in {u["id"] for u in self.store.users(db) if u["active"]}:
                raise APIError("请选择有效负责人")
            if stage not in ["已录用", "已结束"] and (not action or not due):
                raise APIError("进行中的流程必须指定下一步动作和截止时间")
            if stage in ["已录用", "已结束"] and not str(data.get("result", "")).strip():
                raise APIError("结案必须填写结果或结案说明")
            if due:
                parse_time(due)
            a = copy.deepcopy(
                old or {"candidateId": c["id"], "jobId": job["id"], "created": utc(), "history": []}
            )
            if not old or old["stage"] != stage:
                a["history"].append({"stage": stage, "at": utc(), "actor": user["id"]})
            a.update(
                stage=stage,
                ownerId=owner,
                due=due,
                nextAction=action,
                result=str(data.get("result", "")),
                updated=utc(),
            )
            a = self.store.put(db, "applications", a, data.get("rev"))
            self.store.audit(db, user, "更新岗位阶段与责任待办", a["id"])
            return a

    def save_interview(self, data, user):
        self.need(user, "interview")
        with self.store.tx() as db:
            old = self.store.get(db, "interviews", data["id"]) if data.get("id") else None
            if user["role"] == "面试官":
                if not old or old.get("interviewerId") != user["id"]:
                    raise APIError("只能填写本人被安排的面试反馈", 403)
                allowed = [
                    "feedback",
                    "score",
                    "communication",
                    "expertise",
                    "problemSolving",
                    "status",
                    "rev",
                    "id",
                ]
                data = {**old, **{k: v for k, v in data.items() if k in allowed}}
            c = self.check_candidate(db, user, data.get("candidateId", ""))
            job = self.store.get(db, "jobs", data.get("jobId", ""))
            application = self.store.get(db, "applications", data.get("applicationId", ""))
            if application["candidateId"] != c["id"] or application["jobId"] != job["id"]:
                raise APIError("面试必须关联对应岗位人才流程")
            start = parse_time(data.get("time", ""))
            duration = int(data.get("duration", 60))
            if not 15 <= duration <= 480:
                raise APIError("面试时长须为 15–480 分钟")
            interviewer = data.get("interviewerId")
            owner = data.get("ownerId")
            active = {u["id"] for u in self.store.users(db) if u["active"]}
            if interviewer not in active or owner not in active:
                raise APIError("请选择有效面试官与负责人")
            due = data.get("due", "")
            parse_time(due)
            roundno = int(data.get("round", 1))
            if not 1 <= roundno <= 20:
                raise APIError("面试轮次须为 1–20")
            status = data.get("status", "待反馈")
            if status not in ["已安排", "待反馈", "已完成", "已取消"]:
                raise APIError("面试状态无效")
            meeting_mode = data.get("meetingMode", (old or {}).get("meetingMode", "待确认"))
            if meeting_mode not in ["待确认", "电话", "视频", "现场"]:
                raise APIError("面试方式无效")
            meeting_location = str(
                data.get("meetingLocation", (old or {}).get("meetingLocation", ""))
            ).strip()
            if len(meeting_location) > 2000:
                raise APIError("地点或会议链接过长")
            if user["role"] == "面试官" and status not in ["待反馈", "已完成"]:
                raise APIError("面试官仅可提交待反馈或已完成评价", 403)
            for key in ["score", "communication", "expertise", "problemSolving"]:
                value = data.get(key, "")
                if value not in ["", None] and (
                    not str(value).isdigit() or not 1 <= int(value) <= 5
                ):
                    raise APIError("评价只接受 1–5 或留空")
            if status != "已取消":
                end = start + dt.timedelta(minutes=duration)
                for i in self.store.all(db, "interviews"):
                    if i["id"] == data.get("id") or i.get("status") == "已取消":
                        continue
                    a = parse_time(i["time"])
                    b = a + dt.timedelta(minutes=int(i["duration"]))
                    if (
                        start < b
                        and end > a
                        and (i["interviewerId"] == interviewer or i["candidateId"] == c["id"])
                    ):
                        raise APIError("面试时间与该面试官或候选人的现有安排冲突", 409)
            value = {
                k: data.get(k, "")
                for k in [
                    "candidateId",
                    "jobId",
                    "applicationId",
                    "type",
                    "time",
                    "due",
                    "interviewerId",
                    "ownerId",
                    "feedback",
                    "score",
                    "communication",
                    "expertise",
                    "problemSolving",
                    "nextAction",
                ]
            }
            value.update(
                meetingMode=meeting_mode,
                meetingLocation=meeting_location,
                id=data.get("id") or uid(),
                round=roundno,
                duration=duration,
                status=status,
                updated=utc(),
                created=(old or {}).get("created", utc()),
            )
            i = self.store.put(db, "interviews", value, data.get("rev"))
            self.store.audit(db, user, "保存面试安排 / 结构化反馈", i["id"])
            return i

    def upload(self, data, user):
        self.need(user, "write")
        files = data.get("files", [])
        if not isinstance(files, list) or not 1 <= len(files) <= self.settings.max_batch_files:
            raise APIError(f"每批 1–{self.settings.max_batch_files} 份文件")
        # Validate every file before saving the batch; hash-only duplicate files are not reparsed.
        checked = []
        for f in files:
            name = Path(str(f.get("name", "")).replace("\\", "/")).name
            try:
                raw = base64.b64decode(f.get("base64", ""), validate=True)
            except Exception:
                raise APIError("文件编码无效")
            mime = validate_file(name, raw, self.settings.max_upload_bytes)
            checked.append((name, raw, mime))
        with self.store.tx() as db:
            receipt_id = None
            if data.get("requestId"):
                import uuid

                try:
                    request_id = str(uuid.UUID(str(data["requestId"])))
                except ValueError as error:
                    raise APIError("上传请求 ID 必须为 UUID") from error
                receipt_id = str(
                    uuid.uuid5(uuid.NAMESPACE_URL, "talent-upload/" + user["id"] + "/" + request_id)
                )
                fingerprint = hashlib.sha256(
                    json.dumps(
                        {
                            "source": data.get("source", "本地上传"),
                            "files": [
                                (n, hashlib.sha256(raw).hexdigest(), mime)
                                for n, raw, mime in checked
                            ],
                        },
                        ensure_ascii=False,
                    ).encode()
                ).hexdigest()
                try:
                    receipt = self.store.get(db, "uploadRequests", receipt_id)
                except KeyError:
                    receipt = None
                if receipt:
                    if receipt["fingerprint"] != fingerprint:
                        raise APIError("相同上传请求 ID 对应了不同内容", 409)
                    return [self.store.get(db, "imports", id) for id in receipt["taskIds"]]
            existing = self.store.all(db, "resumes")
            config = self.store.get(db, "config", "system")
            out = []
            batch = uid()
            for name, raw, mime in checked:
                hashv = hashlib.sha256(raw).hexdigest()
                identical = next((r for r in existing if r.get("hash") == hashv), None)
                fileid = identical["fileId"] if identical else uid()
                if not identical:
                    (self.store.root / "files" / fileid).write_bytes(raw)
                task = {
                    "name": name,
                    "fileId": fileid,
                    "mime": mime,
                    "hash": hashv,
                    "source": str(data.get("source", "本地上传")),
                    "batchId": batch,
                    "state": "duplicate" if identical else "queued",
                    "saved": True,
                    "parsed": bool(identical),
                    "created": utc(),
                    "actor": user["id"],
                    "attempts": 0,
                    "fields": {},
                    "evidence": {},
                    "pages": [],
                }
                if identical and config.get("extractionMode", config.get("mode")) == "model":
                    task.update(state="queued", parsed=False)
                elif identical:
                    c = self.store.get(db, "candidates", identical["candidateId"])
                    fields, evidence = parse_fields(identical.get("pages", []))
                    fields = identical.get("fields", fields)
                    evidence = identical.get("evidence", evidence)
                    task.update(
                        fields=fields,
                        pages=identical.get("pages", []),
                        evidence=evidence,
                        duplicates=[
                            {
                                "id": c["id"],
                                "name": c["name"],
                                "reasons": ["相同文件 SHA-256"],
                                "fields": {
                                    k: c.get(k, "")
                                    for k in ["name", "phone", "email", "company", "role"]
                                },
                            }
                        ],
                    )
                out.append(self.store.put(db, "imports", task))
                self.store.audit(db, user, "保存导入原件", out[-1]["id"], name)
            if receipt_id:
                self.store.put(
                    db,
                    "uploadRequests",
                    {
                        "id": receipt_id,
                        "fingerprint": fingerprint,
                        "taskIds": [t["id"] for t in out],
                        "actor": user["id"],
                        "created": utc(),
                    },
                )
            return out

    def import_action(self, id, data, user):
        self.need(user, "write")
        with self.store.tx() as db:
            task = self.store.get(db, "imports", id)
            if task["rev"] != data.get("rev"):
                raise Conflict("导入任务已更新，请刷新")
            action = data.get("action")
            if action in ["retry", "reparse"]:
                allowed_states = (
                    ["failed"] if action == "retry" else ["review", "duplicate", "failed"]
                )
                if task["state"] not in allowed_states:
                    raise APIError("当前任务不能重新提取")
                task.update(state="queued", error="", modelWarning="", parsed=False)
                self.store.audit(db, user, "重新提取导入字段", id)
            elif action == "skip":
                if task["state"] in ["done", "skipped", "running"]:
                    raise APIError("当前任务不能跳过")
                task.update(state="skipped", decision="skip")
                self.store.audit(db, user, "跳过导入", id)
            elif action in ["create", "link", "manual"]:
                if task["state"] not in ["review", "duplicate", "failed"]:
                    raise APIError("请等待解析完成后核对")
                if action == "manual" and task["state"] != "failed":
                    raise APIError("手工建档用于失败任务")
                if action == "link":
                    c = self.store.get(db, "candidates", data.get("candidateId", ""))
                else:
                    values = {
                        **task.get("fields", {}),
                        **data.get("fields", {}),
                        "source": task["source"],
                    }
                    c = validate_candidate(values)
                    c["evidence"] = task.get("evidence", {})
                    c["createdBy"] = user["id"]
                    c = self.store.put(db, "candidates", c)
                r = self.store.put(
                    db,
                    "resumes",
                    {
                        "candidateId": c["id"],
                        "name": task["name"],
                        "fileId": task["fileId"],
                        "hash": task["hash"],
                        "mime": task["mime"],
                        "source": task["source"],
                        "text": "\n\n".join(p["text"] for p in task.get("pages", [])),
                        "pages": task.get("pages", []),
                        "fields": task.get("fields", {}),
                        "evidence": task.get("evidence", {}),
                        "created": utc(),
                        "actor": user["name"],
                        "ocr": task.get("ocr", False),
                    },
                )
                c.setdefault("resumeIds", []).append(r["id"])
                if action != "link":
                    c.update(currentResumeId=r["id"], text=r["text"])
                # Linking adds a version without changing selected version or verified fields.
                self.store.put(db, "candidates", c, c["rev"])
                task.update(
                    state="done",
                    decision=action,
                    candidateId=c["id"],
                    resumeId=r["id"],
                    reviewedBy=user["id"],
                    reviewedAt=utc(),
                )
                self.store.audit(db, user, "人工审查导入：" + action, id, c["id"])
            else:
                raise APIError("导入操作无效")
            return self.store.put(db, "imports", task, task["rev"])

    def adopt_resume(self, data, user):
        self.need(user, "write")
        with self.store.tx() as db:
            r = self.store.get(db, "resumes", data["resumeId"])
            c = self.store.get(db, "candidates", r["candidateId"])
            if c["rev"] != data.get("rev"):
                raise Conflict("档案已更新，请刷新")
            fields, evidence = parse_fields(r.get("pages", []))
            fields = r.get("fields", fields)
            evidence = r.get("evidence", evidence)
            c = validate_candidate({**fields, "verified": False}, c)
            c.update(currentResumeId=r["id"], evidence=evidence, verified=False)
            c = self.store.put(db, "candidates", c, c["rev"])
            self.store.audit(db, user, "人工采用简历版本解析值，等待重新核实", c["id"], r["id"])
            return c

    def create_run(self, data, user):
        self.need(user, "write")
        with self.store.tx() as db:
            version = self.store.get(db, "jobVersions", data["versionId"])
            config = self.store.get(db, "config", "system")
            cs = self.store.all(db, "candidates")
            scope = data.get("candidateIds", [])
            if not isinstance(scope, list):
                raise APIError("候选人范围无效")
            cs = [
                c
                for c in cs
                if not missing(c) and c.get("verified") and (not scope or c["id"] in scope)
            ]
            if not cs:
                raise APIError("没有已核实且完整的候选人，请先核对档案")
            snaps = []
            for c in cs:
                r = (
                    self.store.get(db, "resumes", c["currentResumeId"])
                    if c.get("currentResumeId")
                    else None
                )
                snaps.append({"candidate": copy.deepcopy(c), "resume": copy.deepcopy(r)})
            run = self.store.put(
                db,
                "runs",
                {
                    "state": "queued",
                    "versionSnapshot": version,
                    "configSnapshot": config,
                    "snapshots": snaps,
                    "items": [],
                    "errors": [],
                    "scope": len(snaps),
                    "created": utc(),
                    "actor": user["id"],
                    "ruleVersion": RULE_VERSION,
                    "promptVersion": "criterion-evidence-v2.1",
                },
            )
            self.store.audit(db, user, "创建固定输入的匹配任务", run["id"])
            return run

    def admin(self, path, data, user):
        self.need(user, "admin")
        if path == "model-test":
            url = str(data.get("modelUrl", "")).rstrip("/")
            model = str(data.get("model", "")).strip()
            if not model_url_allowed(url):
                raise APIError("模型接口不在允许的端点白名单中")
            if not model:
                raise APIError("请填写模型 ID")
            probe_config = {"modelUrl": url, "model": model}
            api_key = data.get("apiKey") or read_model_key(self.store.root)
            if api_key:
                probe_config["apiKey"] = api_key
            try:
                probe_model(
                    probe_config,
                    timeout=min(20, self.settings.model_timeout_seconds),
                )
            except Exception as error:
                raise APIError(f"模型连接测试失败：{error}", 502) from error
            return {"ok": True, "model": model, "message": "模型连接成功"}
        with self.store.tx() as db:
            if path == "user":
                role = data.get("role", "HR")
                username = str(data.get("username", "")).strip()
                name = str(data.get("name", "")).strip()
                if role not in PERMISSIONS or not username or not name:
                    raise APIError("账号、姓名和角色无效")
                old = db.execute("SELECT * FROM users WHERE id=?", (data.get("id", ""),)).fetchone()
                if old:
                    active = int(bool(data.get("active", True)))
                    if old["id"] == user["id"] and (not active or role != "管理员"):
                        raise APIError("不能禁用本人或移除本人的管理员角色")
                    db.execute(
                        "UPDATE users SET name=?,role=?,active=? WHERE id=?",
                        (name, role, active, old["id"]),
                    )
                    if data.get("password"):
                        db.execute(
                            "UPDATE users SET password=? WHERE id=?",
                            (password_hash(data["password"]), old["id"]),
                        )
                    db.execute("DELETE FROM sessions WHERE user_id=?", (old["id"],))
                else:
                    db.execute(
                        "INSERT INTO users VALUES(?,?,?,?,?,1)",
                        (uid(), username, name, role, password_hash(data.get("password", ""))),
                    )
                self.store.audit(db, user, "维护团队账号", username)
                return {"ok": True}
            if path == "config":
                config = self.store.get(db, "config", "system")
                url = str(data.get("modelUrl", "")).rstrip("/")
                if not model_url_allowed(url):
                    raise APIError("模型接口不在允许的本机端点白名单中")
                mode = data.get("mode", config.get("mode", "rules"))
                extraction_mode = data.get(
                    "extractionMode",
                    config.get("extractionMode", config.get("mode", "rules")),
                )
                if mode not in ["rules", "model"]:
                    raise APIError("岗位匹配模式无效")
                if extraction_mode not in ["rules", "model"]:
                    raise APIError("简历提取模式无效")
                if (mode == "model" or extraction_mode == "model") and not data.get("model"):
                    raise APIError("请填写真实本地模型名")
                config.update(
                    mode=mode,
                    extractionMode=extraction_mode,
                    modelUrl=url,
                    model=str(data.get("model", "")),
                    ocr=bool(data.get("ocr", True)),
                )
                config = self.store.put(db, "config", config, data.get("rev"))
                save_model_key(self.store.root, data.get("apiKey", ""))
                self.store.audit(db, user, "保存本地模型与 OCR 配置")
                return config
        raise APIError("管理接口不存在", 404)

    def file(self, kind, id, user):
        self.need(user, "files")
        with self.store.tx() as db:
            if kind == "import":
                self.need(user, "write")
                r = self.store.get(db, "imports", id)
            else:
                r = self.store.get(db, "resumes", id)
                self.check_candidate(db, user, r["candidateId"])
            mime = r.get("mime", "application/octet-stream")
            if mime not in [
                "application/pdf",
                "text/plain",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ]:
                mime = "application/octet-stream"
            self.store.audit(db, user, "下载 / 查看原始附件", id)
            return (self.store.root / "files" / r["fileId"]).read_bytes(), mime, r["name"]

    def export(self, data, user):
        self.need(user, "export")
        with self.store.tx() as db:
            ids = set(data.get("ids", []))
            cs = [
                self.redact(c, user)
                for c in self.candidate_scope(db, user)
                if not ids or c["id"] in ids
            ]
            self.store.audit(
                db, user, "导出人才数据", str(len(cs)) + " 条", "由服务器按账号权限生成"
            )
            return {"candidates": cs, "created": utc()}

    def backup(self, user):
        self.need(user, "admin")
        with self.store.tx() as db:
            self.store.audit(db, user, "生成一致性工作区备份")
            records = [dict(r) for r in db.execute("SELECT * FROM records WHERE kind!='views'")]
            fileids = set()
            for r in records:
                d = json.loads(r["data"])
                if d.get("fileId"):
                    fileids.add(d["fileId"])
            files = {
                f: base64.b64encode((self.store.root / "files" / f).read_bytes()).decode()
                for f in fileids
            }
            return {
                "format": "talent-team-v2",
                "created": utc(),
                "records": records,
                "users": [dict(r) for r in db.execute("SELECT * FROM users")],
                "audit": [dict(r) for r in db.execute("SELECT * FROM audit")],
                "files": files,
            }

    def restore(self, data, user):
        self.need(user, "admin")
        if data.get("confirm") != "替换工作区":
            raise APIError("请输入确认文字")
        b = data.get("backup", {})
        if (
            b.get("format") != "talent-team-v2"
            or not all(isinstance(b.get(k), list) for k in ["records", "users", "audit"])
            or not isinstance(b.get("files"), dict)
        ):
            raise APIError("备份格式无效")
        allowed = {
            "candidates",
            "jobs",
            "jobVersions",
            "applications",
            "interviews",
            "views",
            "imports",
            "runs",
            "resumes",
            "config",
            "uploadRequests",
        }
        checked = []
        for r in b["records"]:
            if r["kind"] == "views":
                continue
            d = json.loads(r["data"])
            if r["kind"] not in allowed or d.get("id") != r["id"] or int(r["rev"]) < 1:
                raise APIError("备份实体无效")
            if not (r["kind"] == "config" and r["id"] == "system") and not re.fullmatch(
                r"[0-9a-f-]{36}", str(r["id"])
            ):
                raise APIError("备份记录 ID 无效")
            if d.get("fileId") and d["fileId"] not in b["files"]:
                raise APIError("备份缺少原始附件")
        for u in b["users"]:
            if (
                u.get("role") not in PERMISSIONS
                or not re.fullmatch(r"[0-9a-f-]{36}", str(u.get("id", "")))
                or not re.fullmatch(r"[0-9a-f]{32}:[0-9a-f]{128}", str(u.get("password", "")))
            ):
                raise APIError("备份账号信息无效")
        for name, value in b["files"].items():
            if not re.fullmatch(r"[0-9a-f-]{36}", name):
                raise APIError("备份文件 ID 无效")
            checked.append((name, base64.b64decode(value, validate=True)))
        if not any(u.get("role") == "管理员" and u.get("active") for u in b["users"]):
            raise APIError("备份必须包含可用管理员")
        with self.store.tx() as db:
            for name, raw in checked:
                target = self.store.root / "files" / name
                if target.exists() and target.read_bytes() != raw:
                    raise APIError("备份原件与当前文件 ID 冲突，未恢复")
            for name, raw in checked:
                (self.store.root / "files" / name).write_bytes(raw)
            db.execute("DELETE FROM records")
            db.execute("DELETE FROM sessions")
            db.execute("DELETE FROM users")
            db.execute("DELETE FROM audit")
            for r in b["records"]:
                if r["kind"] == "views":
                    continue
                db.execute(
                    "INSERT INTO records VALUES(?,?,?,?)", (r["kind"], r["id"], r["rev"], r["data"])
                )
            for u in b["users"]:
                db.execute(
                    "INSERT INTO users VALUES(?,?,?,?,?,?)",
                    tuple(u[k] for k in ["id", "username", "name", "role", "password", "active"]),
                )
            for a in b["audit"]:
                db.execute(
                    "INSERT INTO audit(time,actor_id,actor,action,entity,detail) VALUES(?,?,?,?,?,?)",
                    tuple(
                        a.get(k, "")
                        for k in ["time", "actor_id", "actor", "action", "entity", "detail"]
                    ),
                )
            for kind in ["imports", "runs"]:
                for r in self.store.all(db, kind):
                    if r["state"] == "running":
                        r["state"] = "queued"
                        self.store.put(db, kind, r, r["rev"])
            self.store.audit(db, user, "恢复完整工作区备份，会话全部失效")
        return {"ok": True, "loginRequired": True}

    def start_worker(self):
        if getattr(self, "worker", None) is not None and self.worker.is_alive():
            return
        self.worker = threading.Thread(target=self.worker_loop, daemon=True)
        self.worker.start()

    def worker_loop(self):
        while not self.stop.is_set():
            work = None
            with self.store.tx() as db:
                for kind in ["imports", "runs"]:
                    task = next(
                        (r for r in self.store.all(db, kind) if r["state"] == "queued"), None
                    )
                    if task:
                        task["state"] = "running"
                        task["started"] = utc()
                        task["attempts"] = task.get("attempts", 0) + 1
                        task = self.store.put(db, kind, task, task["rev"])
                        work = (kind, task)
                        break
            if not work:
                self.stop.wait(0.35)
                continue
            kind, task = work
            try:
                if kind == "imports":
                    self.process_import(task)
                else:
                    self.process_run(task)
            except InterruptedError:
                with self.store.tx() as db:
                    latest = self.store.get(db, kind, task["id"])
                    latest.update(state="queued", recovered=True)
                    self.store.put(db, kind, latest, latest["rev"])
            except Exception as e:
                with self.store.tx() as db:
                    latest = self.store.get(db, kind, task["id"])
                    latest.update(state="failed", error=str(e)[:400], finished=utc())
                    self.store.put(db, kind, latest, latest["rev"])

    def process_import(self, task):
        with self.store.connect() as db:
            config = self.store.get(db, "config", "system")
        pages, ocr = extract(
            self.store.root / "files" / task["fileId"],
            task["name"],
            config.get("ocr", True),
            should_stop=self.stop.is_set,
        )
        fields, evidence = parse_fields(pages)
        model_warning = ""
        parser_mode = "rules"
        if config.get("extractionMode", config.get("mode")) == "model":
            try:
                extracted, model_evidence = model_fields(
                    pages,
                    config | {"apiKey": read_model_key(self.store.root)},
                    timeout=self.settings.model_timeout_seconds,
                )
                fields.update(extracted)
                evidence.update(model_evidence)
                parser_mode = "model"
            except Exception as error:
                model_warning = (
                    "本地模型填表未完成，已保留规则结果，可重新提取：" + str(error)[:250]
                )
        if self.stop.is_set():
            raise InterruptedError("服务停止，解析任务重新排队")
        with self.store.tx() as db:
            task = self.store.get(db, "imports", task["id"])
            duplicates = duplicate_candidates(
                fields,
                task["hash"],
                self.store.all(db, "candidates"),
                self.store.all(db, "resumes"),
            )
            task.update(
                state="duplicate" if duplicates else "review",
                parsed=True,
                fields=fields,
                evidence=evidence,
                pages=pages,
                ocr=ocr,
                parserMode=parser_mode,
                modelWarning=model_warning,
                duplicates=duplicates,
                finished=utc(),
                error="",
            )
            self.store.put(db, "imports", task, task["rev"])

    def process_run(self, task):
        if task.get("ruleVersion") != RULE_VERSION:
            raise ValueError("评分规则版本已更新，请创建新任务；旧成功结果保留")
        done = {r["candidateId"] for r in task.get("items", [])}
        for snap in task["snapshots"]:
            if self.stop.is_set():
                raise InterruptedError("服务停止，未完成任务重新排队")
            c = snap["candidate"]
            if c["id"] in done:
                continue
            try:
                config = task["configSnapshot"]
                model_results = None
                if config["mode"] == "model":
                    model_results = model_dimensions(
                        c,
                        task["versionSnapshot"],
                        config | {"apiKey": read_model_key(self.store.root)},
                        timeout=self.settings.model_timeout_seconds,
                    )
                result = score(c, task["versionSnapshot"], snap["resume"], model_results)
                with self.store.tx() as db:
                    latest = self.store.get(db, "runs", task["id"])
                    latest["items"].append(result)
                    latest["errors"] = [e for e in latest["errors"] if e["candidateId"] != c["id"]]
                    self.store.put(db, "runs", latest, latest["rev"])
            except Exception as e:
                with self.store.tx() as db:
                    latest = self.store.get(db, "runs", task["id"])
                    latest["errors"] = [x for x in latest["errors"] if x["candidateId"] != c["id"]]
                    latest["errors"].append(
                        {"candidateId": c["id"], "name": c["name"], "error": str(e)[:300]}
                    )
                    self.store.put(db, "runs", latest, latest["rev"])
        with self.store.tx() as db:
            latest = self.store.get(db, "runs", task["id"])
            latest.update(state="partial" if latest["errors"] else "done", finished=utc())
            self.store.put(db, "runs", latest, latest["rev"])

    def retry_run(self, id, user):
        self.need(user, "write")
        with self.store.tx() as db:
            r = self.store.get(db, "runs", id)
            if r["state"] not in ["partial", "failed"]:
                raise APIError("只可重试失败 / 部分失败任务")
            if r.get("ruleVersion") != RULE_VERSION:
                raise APIError("评分规则版本已更新，请创建新任务；历史成功结果保留")
            r["state"] = "queued"
            self.store.audit(db, user, "重试匹配失败项（保留成功结果及输入快照）", id)
            return self.store.put(db, "runs", r, r["rev"])


def parse_time(value):
    try:
        t = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not t.tzinfo:
            raise ValueError()
        return t.astimezone(dt.timezone.utc)
    except (ValueError, AttributeError, TypeError):
        raise APIError("请选择有效日期时间（含时区）")
