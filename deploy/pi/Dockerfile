FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY collector/ ./collector/

CMD ["python3", "-m", "collector.main", "--db", "/data/queue.sqlite3"]
