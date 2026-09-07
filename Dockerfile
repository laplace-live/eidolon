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

# No X11/GL runtime is installed on purpose: `pipecat-ai[webrtc]` pulls
# `opencv-python-headless`, and this bot is audio-only so it never imports
# `cv2` at all. Adding the `webrtc-video` extra reintroduces the GUI build
# and with it `libGL.so.1` / `libxcb.so.1` / `libgthread-2.0.so.0` import
# errors on this slim base — install those libs in the same commit.

# Install dependencies first (separate layer = better cache hits when
# only application code changes).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Copy the application code and data assets.
# - laplace_eidolon/: the package itself (bot, embeddings, openrouter,
#   persona_facts, stream_archive, and the tools/ subpackage).
# - persona.md: system prompt source of truth, hot-editable at root.
# - data/: prebuilt LanceDB indexes — stream_chunks (built via
#   `uv run laplace-ingest-streams`) and persona_facts (built via
#   `uv run laplace-ingest-facts`). Build these locally before
#   `docker build` if you want RAG enabled in the container; both
#   services gracefully no-op when their tables are absent.
# - README.md: hatchling reads it during the project install step.
COPY ./pyproject.toml ./uv.lock ./README.md ./
COPY ./laplace_eidolon ./laplace_eidolon
COPY ./persona.md ./
COPY ./data ./data

# Install the project itself now that the source is in place — this
# registers the laplace-* console scripts in /app/.venv/bin/ and makes
# ``python -m laplace_eidolon.bot`` resolvable from any CWD.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev

EXPOSE 7860

# Pipecat's runner discovers the ``bot()`` function via
# ``sys.modules["__main__"]``, which a generated console-script
# launcher doesn't satisfy. We invoke the bot via ``python -m`` so
# the module IS __main__. The runner reads --host/--port flags (no
# native env-var support today), so we expand the env vars here.
CMD ["sh", "-c", "uv run python -m laplace_eidolon.bot --host ${PIPECAT_HOST} --port ${PIPECAT_PORT}"]
