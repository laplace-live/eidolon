# Self-hosted laplace-eidolon.
#
# We previously used `dailyco/pipecat-base:latest`, which is the Pipecat
# Cloud base image. That image has no CMD and expects PCC's session
# manager to invoke `bot()` per session — it does NOT run a web server.
# For self-hosting we want the dev runner (FastAPI on :7860 with the
# `/api/offer` SmallWebRTC signaling endpoint), so we use a stock
# Python image and run `bot.py` directly.

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    # Bind the dev runner to all interfaces inside the container so the
    # host's published port reaches it. Override at `docker run` if you
    # want to wrap the runner with a different uvicorn invocation.
    PIPECAT_HOST=0.0.0.0 \
    PIPECAT_PORT=7860

WORKDIR /app

# Native libraries required by `opencv-python` (pulled in transitively by
# `pipecat-ai[webrtc]` → `SmallWebRTCTransport` → `cv2`). The slim base
# image ships no X11/GL runtime, so without these the bot fails to import
# `cv2` with `libxcb.so.1` / `libGL.so.1` / `libgthread-2.0.so.0` errors.
# We use the GUI build (not opencv-python-headless) because that's what
# the pipecat lockfile pins; switching would mean fighting the lock.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libxcb1 \
        libsm6 \
        libxext6 \
        libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (separate layer = better cache hits when
# only application code changes).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Copy the application code and data assets.
# - bot.py / stream_archive.py / persona_facts.py / embeddings.py: runtime
# - openrouter.py: shared OpenRouter request-header + cost-extraction
#   helpers, imported by bot.py and embeddings.py
# - persona.md: system prompt source of truth
# - streams/: transcripts (small, committed; useful for inspection at
#   runtime though retrieval reads from the prebuilt LanceDB index)
# - data/: prebuilt LanceDB indexes — stream_chunks (built via
#   `uv run python -m tools.ingest_streams`) and persona_facts (built
#   via `uv run python -m tools.ingest_facts`). Build these locally
#   before `docker build` if you want RAG enabled in the container;
#   both services gracefully no-op when their tables are absent.
COPY ./pyproject.toml ./uv.lock ./
COPY ./bot.py ./stream_archive.py ./persona_facts.py ./embeddings.py ./openrouter.py ./
COPY ./persona.md ./
COPY ./data ./data

EXPOSE 7860

# `uv run` resolves the lock and execs `bot.py`, which calls
# `pipecat.runner.run.main()`. The runner reads --host/--port flags
# (no native env-var support today), so we expand the env vars here.
CMD ["sh", "-c", "uv run bot.py --host ${PIPECAT_HOST} --port ${PIPECAT_PORT}"]
