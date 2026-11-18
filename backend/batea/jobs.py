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


def start_chain(items: list[tuple[str, str, Callable[[Job], dict | None]]]) -> list[Job]:
    """Varias tareas una detrás de otra en un solo hilo (p. ej. sincronizar rekordbox y después Traktor).

    Devuelve un Job por tarea, todos "running" desde el principio; los que esperan dicen "En espera".
    Si ya había una corriendo del mismo tipo, se devuelve esa y no se duplica."""
    pending: list[tuple[Job, Callable[[Job], dict | None]]] = []
    out: list[Job] = []
    with _lock:
        for kind, label, fn in items:
            dup = next((j for j in _jobs.values() if j.kind == kind and j.status == "running"), None)
            if dup:
                out.append(dup)
                continue
            job = Job(id=uuid.uuid4().hex[:10], kind=kind, label=label, message="En espera")
            _jobs[job.id] = job
            pending.append((job, fn))
            out.append(job)

    def run() -> None:
        for job, fn in pending:
            try:
                if job.cancelled:
                    job.message = "Cancelado"
                    job.result = {"cancelado": True}
                    job.status = "done"
                    continue
                job.message = ""
                job.result = fn(job) or {}
                job.status = "done"
                job.progress = 1.0
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                job.status = "error"
                job.message = f"{type(e).__name__}: {e}"
            finally:
                job.finished = time.time()

    if pending:
        threading.Thread(target=run, daemon=True, name="job-chain").start()
    return out
