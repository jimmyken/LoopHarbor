from celery import Celery
from app.config import REDIS_URL, CELERY_RESULT_BACKEND

celery_app = Celery(
    "async_agent",
    broker=REDIS_URL,
    backend=CELERY_RESULT_BACKEND,
    include=["app.tasks"],
)

celery_app.conf.update(
    task_track_started=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=86400,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    broker_connection_retry_on_startup=True,
    task_time_limit=900,
    task_soft_time_limit=840,
)
