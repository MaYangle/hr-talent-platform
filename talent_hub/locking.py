"""An OS-held, crash-safe lock for the single-worker workspace."""

import os
from pathlib import Path


class WorkspaceInUseError(RuntimeError):
    pass


class WorkspaceLock:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._file = None

    def acquire(self):
        self.root.mkdir(parents=True, exist_ok=True)
        handle = (self.root / ".workspace.lock").open("a+b")
        try:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            handle.close()
            raise WorkspaceInUseError(
                "该数据目录已由另一个 Talent Hub 服务使用，请先停止旧服务"
            ) from error
        self._file = handle
        return self

    def release(self):
        if self._file is not None:
            self._file.close()  # Closing releases the OS lock, including after a process crash.
            self._file = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_):
        self.release()
