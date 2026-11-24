import os
from dotenv import load_dotenv

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = os.getenv(
    "CELERY_RESULT_BACKEND", "redis://localhost:6379/1"
)
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://agent:agentpass@localhost:5432/agentdb",
)
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "")
MEMORY_SUMMARIZE_EVERY_TURNS = int(os.getenv("MEMORY_SUMMARIZE_EVERY_TURNS", "5"))
if MEMORY_SUMMARIZE_EVERY_TURNS < 1:
    raise ValueError("MEMORY_SUMMARIZE_EVERY_TURNS 必须是大于 0 的整数")
