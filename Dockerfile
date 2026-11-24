FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN useradd --create-home --uid 10001 app
COPY --chown=app:app loopharbor ./loopharbor

USER app

CMD ["uvicorn", "loopharbor.main:app", "--host", "0.0.0.0", "--port", "8000"]
