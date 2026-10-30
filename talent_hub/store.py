import contextlib
import copy
import hashlib
import json
import secrets
import sqlite3
from pathlib import Path

from .config import Settings
from .domain import uid, utc

DEFAULT_MODEL = "Qwen/Qwen3.8-27B"
DEFAULT_MODEL_URL = "http://172.30.0.101:20001/v1"
PREVIOUS_MODEL_URL = "http://127.0.0.1:11434/v1"


class Conflict(Exception):
    pass


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def password_hash(password):
    if not isinstance(password, str) or len(password) < 10:
        raise ValueError("密码至少 10 个字符")
    salt = secrets.token_hex(16)
    return (
        salt
        + ":"
        + hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    )


def password_ok(password, stored):
    salt, expected = stored.split(":")
    actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return secrets.compare_digest(actual, expected)


class Store:
    def __init__(self, path=None):
        self.root = Path(path or Settings.from_env().data_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "files").mkdir(exist_ok=True)
        self.path = self.root / "talent.sqlite3"
        with self.connect() as db:
            db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied TEXT);
            CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf TEXT NOT NULL,expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,actor_id TEXT,actor TEXT,action TEXT,entity TEXT,detail TEXT);
            INSERT OR IGNORE INTO migrations VALUES(1,CURRENT_TIMESTAMP);
            """)
            db.execute("DELETE FROM records WHERE kind='views'")
            # A claimed task is requeued on process restart; completed items remain intact.
            for kind in ["imports", "runs"]:
                for r in self.all(db, kind):
                    if r.get("state") == "running":
                        r["state"] = "queued"
                        r["recovered"] = True
                        self.put(db, kind, r, r["rev"])
            if not self.all(db, "config"):
                self.put(
                    db,
                    "config",
                    {
                        "id": "system",
                        "mode": "rules",
                        "extractionMode": "model",
                        "modelUrl": DEFAULT_MODEL_URL,
                        "model": DEFAULT_MODEL,
                        "ocr": True,
                        "modelDefaultsVersion": 2,
                    },
                )
            else:
                config = self.get(db, "config", "system")
                defaults_version = config.get("modelDefaultsVersion", 0)
                if defaults_version < 1:
                    using_previous_defaults = config.get("modelUrl") in [
                        None,
                        "",
                        PREVIOUS_MODEL_URL,
                    ] and not config.get("model")
                    if not config.get("model"):
                        config["model"] = DEFAULT_MODEL
                    if config.get("modelUrl") in [None, "", PREVIOUS_MODEL_URL]:
                        config["modelUrl"] = DEFAULT_MODEL_URL
                    if using_previous_defaults and "extractionMode" not in config:
                        config["extractionMode"] = "model"
                    defaults_version = 1
                if defaults_version < 2:
                    if (
                        config.get("modelUrl") == DEFAULT_MODEL_URL
                        and config.get("model") == DEFAULT_MODEL
                        and config.get("extractionMode") == "rules"
                    ):
                        config["extractionMode"] = "model"
                    config["modelDefaultsVersion"] = 2
                    self.put(db, "config", config, config["rev"])

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30, factory=ClosingConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextlib.contextmanager
    def tx(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def all(self, db, kind):
        return [
            self.decode(r)
            for r in db.execute("SELECT * FROM records WHERE kind=? ORDER BY rowid", (kind,))
        ]

    def get(self, db, kind, id):
        r = db.execute("SELECT * FROM records WHERE kind=? AND id=?", (kind, str(id))).fetchone()
        if not r:
            raise KeyError("记录不存在")
        return self.decode(r)

    def decode(self, r):
        d = json.loads(r["data"])
        d["id"] = r["id"]
        d["rev"] = r["rev"]
        return d

    def put(self, db, kind, data, expected=None):
        d = copy.deepcopy(data)
        id = str(d.get("id") or uid())
        row = db.execute("SELECT rev FROM records WHERE kind=? AND id=?", (kind, id)).fetchone()
        if row and expected != row["rev"]:
            raise Conflict("档案已被其他人更新，请刷新后重新编辑（未覆盖他人修改）")
        if not row and expected not in [None, 0]:
            raise Conflict("记录已不存在，请刷新")
        rev = (row["rev"] if row else 0) + 1
        d.update(id=id, rev=rev, organizationId="internal")
        db.execute(
            "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET rev=excluded.rev,data=excluded.data",
            (kind, id, rev, json.dumps(d, ensure_ascii=False)),
        )
        return d

    def audit(self, db, user, action, entity="", detail=""):
        db.execute(
            "INSERT INTO audit(time,actor_id,actor,action,entity,detail) VALUES(?,?,?,?,?,?)",
            (
                utc(),
                user.get("id"),
                user.get("name", "系统"),
                action,
                str(entity),
                str(detail)[:1000],
            ),
        )

    def users(self, db):
        return [
            dict(r)
            for r in db.execute("SELECT id,username,name,role,active FROM users ORDER BY rowid")
        ]
