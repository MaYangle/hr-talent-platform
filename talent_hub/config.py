"""Validated process configuration. Business/model choices remain in the database."""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


def _integer(env: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(env.get(name, str(default)))
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 4173
    allowed_hosts: frozenset[str] = frozenset({"localhost", "127.0.0.1", "::1"})
    secure_cookie: bool = False
    max_request_bytes: int = 80 * 1024 * 1024
    max_upload_bytes: int = 20 * 1024 * 1024
    max_batch_files: int = 50
    session_hours: int = 8
    model_timeout_seconds: int = 120
    request_timeout_seconds: int = 30

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        default_root = Path(env.get("LOCALAPPDATA") or Path.home()) / "TalentHub/workspace-v2"
        root = Path(env.get("TALENT_DATA_DIR") or default_root).expanduser().resolve()
        extra_hosts = {
            h.strip().lower() for h in env.get("TALENT_ALLOWED_HOSTS", "").split(",") if h.strip()
        }
        if any("/" in h or ":" in h and h != "::1" or " " in h for h in extra_hosts):
            raise ValueError(
                "TALENT_ALLOWED_HOSTS must contain hostnames/IPs without schemes or ports"
            )
        cookie = env.get("TALENT_SECURE_COOKIE", "0")
        if cookie not in ["0", "1"]:
            raise ValueError("TALENT_SECURE_COOKIE must be 0 or 1")
        return cls(
            data_dir=root,
            host=env.get("TALENT_HOST", "127.0.0.1"),
            port=_integer(env, "TALENT_PORT", 4173, 1, 65535),
            allowed_hosts=frozenset({"localhost", "127.0.0.1", "::1"} | extra_hosts),
            secure_cookie=cookie == "1",
            max_request_bytes=_integer(env, "TALENT_MAX_REQUEST_MIB", 80, 1, 512) * 1024 * 1024,
            max_upload_bytes=_integer(env, "TALENT_MAX_UPLOAD_MIB", 20, 1, 100) * 1024 * 1024,
            max_batch_files=_integer(env, "TALENT_MAX_BATCH_FILES", 50, 1, 100),
            session_hours=_integer(env, "TALENT_SESSION_HOURS", 8, 1, 24),
            model_timeout_seconds=_integer(env, "TALENT_MODEL_TIMEOUT_SECONDS", 120, 1, 300),
            request_timeout_seconds=_integer(env, "TALENT_REQUEST_TIMEOUT_SECONDS", 30, 1, 300),
        )
