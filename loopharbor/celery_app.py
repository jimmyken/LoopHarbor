from celery import Celery

from .config import settings

celery_app = Celery(
    "loopharbor",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["loopharbor.worker"],
)
celery_app.conf.update(
    accept_content=["json"],
    result_serializer="json",
    task_serializer="json",
    task_track_started=True,
    timezone="UTC",
    enable_utc=True,
)
