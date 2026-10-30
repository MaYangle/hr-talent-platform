"""Own the process lifecycle, workspace lock, HTTP listener and worker."""

import argparse
import signal
import threading
from dataclasses import replace
from http.server import ThreadingHTTPServer

from .config import Settings
from .http import handler_class
from .locking import WorkspaceLock
from .service import Service
from .store import Store


class Application:
    def __init__(self, settings: Settings, *, address=None):
        self.settings = settings
        self.lock = WorkspaceLock(settings.data_dir).acquire()
        self.http = None
        self.service = None
        try:
            self.service = Service(Store(settings.data_dir), settings=settings)
            self.http = ThreadingHTTPServer(
                address or (settings.host, settings.port), handler_class(self.service)
            )
            self.http.daemon_threads = True
            # Bind first: an occupied port must never leave an orphaned worker running.
            self.service.start_worker()
        except Exception:
            self.close()
            raise

    def close(self):
        if self.http is not None:
            self.http.server_close()
            self.http = None
        if self.service is not None:
            self.service.stop.set()
            worker = getattr(self.service, "worker", None)
            if worker is not None:
                worker.join(timeout=max(90, self.settings.model_timeout_seconds) + 10)
        self.lock.release()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def main():
    parser = argparse.ArgumentParser(description="Talent Hub self-hosted HR workspace")
    parser.add_argument("--host", help="Override TALENT_HOST (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, help="Override TALENT_PORT (default: 4173)")
    args = parser.parse_args()
    try:
        settings = Settings.from_env()
        if args.host is not None:
            settings = replace(settings, host=args.host)
        if args.port is not None:
            if not 1 <= args.port <= 65535:
                raise ValueError("--port must be between 1 and 65535")
            settings = replace(settings, port=args.port)
        with Application(settings) as app:
            http = app.http

            def stop_server(*_):
                app.service.stop.set()
                # shutdown must run outside the serve_forever thread.
                threading.Thread(target=http.shutdown, daemon=True).start()

            previous_term = signal.signal(signal.SIGTERM, stop_server)
            try:
                print(
                    f"Talent Hub: http://127.0.0.1:{http.server_port}\n"
                    f"Data directory: {settings.data_dir}",
                    flush=True,
                )
                http.serve_forever(poll_interval=0.25)
            except KeyboardInterrupt:
                app.service.stop.set()
            finally:
                signal.signal(signal.SIGTERM, previous_term)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"Startup failed: {error}\n")
