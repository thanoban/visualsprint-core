# Single Dockerfile for both the API and the worker — they're the same
# codebase with different entrypoints and different dependency footprints.
# The API only serves HTTP over Postgres reads/writes and needs none of the
# heavy ML extras (torch, paddleocr, pyannote); the worker actually runs the
# pipeline stages and needs all of them. INSTALL_EXTRAS controls which are
# baked into a given build — see infra/docker-compose.yml for how the api
# and worker services each set it.
FROM python:3.12-slim AS base

WORKDIR /app

# ffmpeg: blob_ingest.py's FLAC transcode path (fallback stores raw bytes if
# absent, but a real deploy should have it). libgl1: opencv-python (screen
# extra) needs it even headless, or `import cv2` fails at C-extension load.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

ARG INSTALL_EXTRAS=""
RUN if [ -n "$INSTALL_EXTRAS" ]; then \
        pip install --no-cache-dir -e ".[$INSTALL_EXTRAS]"; \
    else \
        pip install --no-cache-dir -e .; \
    fi

# Default target: the API. infra/docker-compose.yml overrides `command` for
# the worker service to run the pipeline loop instead.
#
# Cloud Run injects $PORT (8080 by default) and health-checks the container
# on exactly that port -- a hardcoded --port 8000 here fails deployment
# ("failed to start and listen on the port... within the allocated
# timeout") even though the process is running fine. Falls back to 8000
# when $PORT is unset, which is what infra/docker-compose.yml's "8000:8000"
# mapping expects for local dev -- one CMD works correctly in both places.
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
