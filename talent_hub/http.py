"""Authenticated HTTP transport and explicit static-file boundary."""

import base64
import json
import mimetypes
import secrets
import sqlite3
import tempfile
import urllib.parse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from . import __version__
from .metrics import calculate
from .parsing import extract, validate_file
from .service import APIError
from .store import Conflict, password_hash, password_ok

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"


def handler_class(service, web_root=None):
    settings = service.settings
    asset_root = Path(web_root or WEB_ROOT).resolve()

    class Handler(BaseHTTPRequestHandler):
        server_version = "TalentHub/" + __version__

        def setup(self):
            super().setup()
            self.connection.settimeout(settings.request_timeout_seconds)

        def log_message(self, *args):
            pass  # Never log filenames, query strings or profile payloads.

        def send(
            self,
            value,
            status=200,
            extra=None,
            mime="application/json; charset=utf-8",
            frameable=False,
        ):
            raw = (
                value
                if isinstance(value, bytes)
                else json.dumps(value, ensure_ascii=False).encode()
            )
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "SAMEORIGIN" if frameable else "DENY")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors "
                + ("'self'" if frameable else "'none'"),
            )
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def user(self):
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie.get("talent_session")
            return service.session(token.value if token else "")

        def do_GET(self):
            try:
                self.check_host()
                path = urllib.parse.urlparse(self.path).path
                if path == "/health/live":
                    return self.send(
                        {"status": "ok", "application": "talent-hub", "version": __version__}
                    )
                if path == "/health/ready":
                    try:
                        with service.store.connect() as db:
                            db.execute("SELECT 1").fetchone()
                        ready = (
                            getattr(service, "worker", None) is not None
                            and service.worker.is_alive()
                        )
                    except sqlite3.Error:
                        ready = False
                    return self.send(
                        {"status": "ready" if ready else "not_ready"}, 200 if ready else 503
                    )
                if path == "/api/status":
                    with service.store.connect() as db:
                        needed = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
                    return self.send(
                        {
                            "setupRequired": needed,
                            "application": "talent-hub",
                            "version": __version__,
                        }
                    )
                if path == "/api/boot":
                    return self.send(service.boot(self.user()))
                if path == "/api/backup":
                    return self.send(
                        service.backup(self.user()),
                        extra={
                            "Content-Disposition": 'attachment; filename="talent-team-backup.json"'
                        },
                    )
                if path.startswith("/api/preview/"):
                    from .parsing import document_preview, pdf_preview

                    parts = path.split("/")
                    if len(parts) != 5 or parts[3] != "resume" or not parts[4]:
                        raise APIError("预览路径无效", 400)
                    raw, mime, name = service.file("resume", parts[4], self.user())
                    if mime == "application/pdf":
                        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                        page_number = query.get("page", [None])[0]
                        if page_number is not None:
                            page_number = int(page_number)
                        content, preview_mime = pdf_preview(raw, path, page_number)
                        return self.send(content, mime=preview_mime, frameable=page_number is None)
                    return self.send(
                        document_preview(raw, name), mime="text/html; charset=utf-8", frameable=True
                    )
                if path.startswith("/api/file/"):
                    parts = path.split("/")
                    if len(parts) != 5 or parts[3] not in ["resume", "import"] or not parts[4]:
                        raise APIError("附件路径无效", 400)
                    raw, mime, name = service.file(parts[3], parts[4], self.user())
                    return self.send(
                        raw,
                        extra={
                            "Content-Disposition": "inline; filename*=UTF-8''"
                            + urllib.parse.quote(name)
                        },
                        mime=mime,
                    )
                if path.startswith("/api/detail/"):
                    p = path.split("/")
                    if len(p) != 5 or not p[4]:
                        raise APIError("记录路径无效", 400)
                    return self.send(service.detail(p[3], p[4], self.user()))
                if path.startswith("/api/"):
                    raise APIError("接口不存在", 404)
                # Explicit static allowlist: no user data, source server files or DB exposed.
                name = "index.html" if path == "/" else urllib.parse.unquote(path).lstrip("/")
                safe = {
                    "index.html",
                    "app.js",
                    "team.css",
                    "base.css",
                    "reference-theme.css",
                    "lib/ui.js",
                }
                if name not in safe:
                    raise APIError("资源不存在", 404)
                file = (asset_root / name).resolve()
                if asset_root not in file.parents or not file.is_file():
                    raise APIError("资源不存在", 404)
                mime = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
                self.send(
                    file.read_bytes(),
                    mime=mime
                    + (
                        "; charset=utf-8"
                        if mime.startswith("text/") or mime == "application/javascript"
                        else ""
                    ),
                )
            except Exception as e:
                self.error(e)

        def do_POST(self):
            try:
                self.check_host()
                # Required even for login/setup to prevent login CSRF. Host checked against server bind config.
                host = self.headers.get("Host", "")
                origin = self.headers.get("Origin", "")
                allowed = {f"http://{host}", f"https://{host}"}
                if origin not in allowed:
                    raise APIError("请求来源不匹配", 403)
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= settings.max_request_bytes:
                    raise APIError("请求体为空或超过服务配置上限", 413)
                if "application/json" not in self.headers.get("Content-Type", ""):
                    raise APIError("请发送 JSON", 415)
                data = json.loads(self.rfile.read(length))
                path = urllib.parse.urlparse(self.path).path.removeprefix("/api/")
                if not isinstance(data, dict):
                    raise APIError("JSON 对象无效")
                if path in ["setup", "login"]:
                    result = service.auth(path, data, self.client_address[0])
                    token = result.pop("token")
                    cookie = (
                        f"talent_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={settings.session_hours * 3600}"
                        + ("; Secure" if settings.secure_cookie else "")
                    )
                    return self.send(result, extra={"Set-Cookie": cookie})
                user = self.user()
                if not secrets.compare_digest(self.headers.get("X-CSRF-Token", ""), user["csrf"]):
                    raise APIError("请求校验失败，请刷新后重试", 403)
                if path == "logout":
                    with service.store.tx() as db:
                        db.execute("DELETE FROM sessions WHERE csrf=?", (user["csrf"],))
                        service.store.audit(db, user, "退出登录")
                    return self.send(
                        {"ok": True},
                        extra={
                            "Set-Cookie": "talent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
                        },
                    )
                if path == "password":
                    with service.store.tx() as db:
                        row = db.execute(
                            "SELECT password FROM users WHERE id=?", (user["id"],)
                        ).fetchone()
                        if not password_ok(str(data.get("old", "")), row["password"]):
                            raise APIError("原密码不正确")
                        db.execute(
                            "UPDATE users SET password=? WHERE id=?",
                            (password_hash(data.get("password", "")), user["id"]),
                        )
                        db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
                        service.store.audit(db, user, "修改密码并注销全部会话")
                    return self.send({"ok": True, "loginRequired": True})
                routes = {
                    "candidate": service.save_candidate,
                    "job": service.save_job,
                    "application": service.save_application,
                    "interview": service.save_interview,
                    "upload": service.upload,
                    "adopt": service.adopt_resume,
                    "run": service.create_run,
                    "export": service.export,
                    "restore": service.restore,
                }
                if path in routes:
                    return self.send(routes[path](data, user))
                if path == "jd-text":
                    service.need(user, "write")
                    f = data.get("file", {})
                    raw = base64.b64decode(f.get("base64", ""), validate=True)
                    validate_file(f.get("name", ""), raw, settings.max_upload_bytes)
                    with tempfile.TemporaryDirectory(prefix="talent-jd-") as tmp:
                        target = Path(tmp) / "document"
                        target.write_bytes(raw)
                        pages, ocr = extract(target, f["name"], True)
                    return self.send({"text": "\n\n".join(p["text"] for p in pages), "ocr": ocr})
                if path == "export-run":
                    service.need(user, "export")
                    result = service.detail("run", data["id"], user)
                    with service.store.tx() as db:
                        service.store.audit(db, user, "导出固定匹配快照", data["id"])
                    return self.send(result)
                if path.startswith("import/"):
                    return self.send(service.import_action(path.split("/")[1], data, user))
                if path.startswith("retry-run/"):
                    return self.send(service.retry_run(path.split("/")[1], user))
                if path.startswith("admin/"):
                    return self.send(service.admin(path.split("/")[1], data, user))
                if path == "metrics":
                    if user["role"] == "面试官":
                        raise APIError("当前角色不能查看团队汇总", 403)
                    with service.store.connect() as db:
                        result = calculate(service.store, db, data)
                    if data.get("export"):
                        service.need(user, "export")
                        with service.store.tx() as db:
                            service.store.audit(
                                db,
                                user,
                                "导出招聘运营汇总",
                                detail=json.dumps(data, ensure_ascii=False),
                            )
                    return self.send(result)
                raise APIError("接口不存在", 404)
            except Exception as e:
                self.error(e)

        def check_host(self):
            hostname = urllib.parse.urlsplit("//" + self.headers.get("Host", "")).hostname
            allowed = settings.allowed_hosts
            if hostname not in allowed:
                raise APIError("此访问域名未获授权，请配置 TALENT_ALLOWED_HOSTS", 403)

        def error(self, e):
            if isinstance(e, (BrokenPipeError, ConnectionResetError)):
                return
            if isinstance(e, APIError):
                status = e.status
                message = str(e)
            elif isinstance(e, Conflict):
                status = 409
                message = str(e)
            elif isinstance(e, KeyError):
                status = 404
                message = "记录不存在"
            elif isinstance(
                e, (ValueError, TypeError, json.JSONDecodeError, sqlite3.IntegrityError)
            ):
                status = 400
                message = str(e)[:300]
            else:
                status = 500
                message = "服务处理失败，请查看任务状态或联系管理员"
                print("request_error", type(e).__name__, flush=True)
            self.send({"error": message}, status)

    return Handler
