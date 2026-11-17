"""Tareas en segundo plano con progreso (sincronizar, analizar)."""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from typing import Callable


@dataclass
class Job:
    id: str
    kind: str
    label: str
    status: str = "running"   # running | done | error
    progress: float = 0.0
    message: str = ""
    result: dict = field(default_factory=dict)
    started: float = field(default_factory=time.time)
    finished: float | None = None
    cancelled: bool = False

    def update(self, progress: float | None = None, message: str | None = None) -> None:
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))
        if message is not None:
            self.message = message


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def start(kind: str, label: str, fn: Callable[[Job], dict | None]) -> Job:
    with _lock:
        for j in _jobs.values():
            if j.kind == kind and j.status == "running":
                return j
        job = Job(id=uuid.uuid4().hex[:10], kind=kind, label=label)
        _jobs[job.id] = job

    def run() -> None:
        try:
            job.result = fn(job) or {}
            job.status = "done"
            job.progress = 1.0
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job.status = "error"
            job.message = f"{type(e).__name__}: {e}"
        finally:
            job.finished = time.time()

    threading.Thread(target=run, daemon=True, name=f"job-{kind}").start()
    return job


def cancel(job_id: str) -> bool:
    with _lock:
        j = _jobs.get(job_id)
        if j and j.status == "running":
            j.cancelled = True
            return True
    return False


def list_jobs() -> list[dict]:
    now = time.time()
    with _lock:
        for k in [k for k, j in _jobs.items() if j.finished and now - j.finished > 600]:
            del _jobs[k]
        return [asdict(j) for j in sorted(_jobs.values(), key=lambda j: -j.started)]
