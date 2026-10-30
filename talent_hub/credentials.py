"""Workspace-local credentials, separate from database records and backups."""

import ctypes
import os
from pathlib import Path


def _windows_crypt(value, decrypt=False):
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_char))]

    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    target = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    if decrypt:
        success = crypt.CryptUnprotectData(
            ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)
        )
    else:
        success = crypt.CryptProtectData(
            ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)
        )
    if not success:
        raise ValueError("无法访问模型密钥，请使用运行服务的系统账号重新配置")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(ctypes.cast(target.data, ctypes.c_void_p))


def read_model_key(root):
    path = Path(root) / "model-key.secret"
    if not path.exists():
        return os.environ.get("TALENT_MODEL_API_KEY", "")
    value = path.read_bytes()
    if os.name == "nt":
        value = _windows_crypt(value, decrypt=True)
    return value.decode("utf-8")


def save_model_key(root, key):
    if not isinstance(key, str) or len(key) > 4096 or any(char.isspace() for char in key):
        raise ValueError("API Key 格式无效")
    if not key:
        return
    value = key.encode("utf-8")
    if os.name == "nt":
        value = _windows_crypt(value)
    path = Path(root) / "model-key.secret"
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(value)
    temporary.replace(path)