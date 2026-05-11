FROM dailyco/pipecat-base:latest

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy from the cache instead of linking since it's a mounted volume
ENV UV_LINK_MODE=copy

# Uncomment if you wish to print a summary of the features available in the base image
# ENV PCC_LOG_FEATURES_SUMMARY=true

# Install the project's dependencies using the lockfile and settings
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Copy the application code and data assets.
# - bot.py / archive.py: runtime
# - persona.md: system prompt source of truth
# - streams/: transcripts (small, committed; useful for inspection at runtime
#   though retrieval reads from the prebuilt LanceDB index)
# - data/: prebuilt LanceDB index (built locally via `uv run python -m tools.ingest_streams`).
#   The directory is kept alive in git via data/.gitkeep so this COPY succeeds
#   even on a fresh checkout where ingest hasn't been run yet — StreamArchive
#   gracefully no-ops when the lancedb subdir is absent.
COPY ./bot.py bot.py
COPY ./archive.py archive.py
COPY ./persona.md persona.md
COPY ./streams ./streams
COPY ./data ./data
