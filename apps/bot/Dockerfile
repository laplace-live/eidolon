# syntax=docker/dockerfile:1
# The TypeScript bot. Its build context is the repo root, not apps/bot.
FROM oven/bun:1.4.4

WORKDIR /app

# Bun.serve defaults `development` to NODE_ENV !== "production", which answers an
# uncaught handler error with an HTML debug page instead of a plain 500.
ENV NODE_ENV=production \
    PIPECAT_HOST=0.0.0.0 \
    PIPECAT_PORT=7860

# Every workspace manifest, apps/cli's, apps/eidolon's and apps/web's included, so
# --frozen-lockfile checks each against bun.lock and fails on one that drifted.
COPY package.json bun.lock ./
COPY apps/bot/package.json apps/bot/
COPY apps/cli/package.json apps/cli/
COPY apps/eidolon/package.json apps/eidolon/
COPY apps/web/package.json apps/web/
COPY packages/access/package.json packages/access/
COPY packages/chat/package.json packages/chat/
COPY packages/config/package.json packages/config/
COPY packages/context/package.json packages/context/
COPY packages/core/package.json packages/core/
COPY packages/engine/package.json packages/engine/
COPY packages/imagegen/package.json packages/imagegen/
COPY packages/ingest/package.json packages/ingest/
COPY packages/memory/package.json packages/memory/
COPY packages/providers/package.json packages/providers/
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sdk/package.json packages/sdk/
COPY packages/tools/package.json packages/tools/
COPY packages/turn/package.json packages/turn/
COPY packages/usage/package.json packages/usage/
COPY packages/voice/package.json packages/voice/
COPY packages/webrtc/package.json packages/webrtc/

# onnxruntime-node's postinstall stays blocked (Bun runs no untrusted lifecycle
# scripts): on linux/x64 it downloads the CUDA execution provider, and the CPU
# binaries already ship in the tarball. Never add it to trustedDependencies.
#
# --filter skips the browser SDK's dependencies (its manifest is still checked
# against bun.lock). The prune removes what the bot never loads. LanceDB's optional
# @huggingface/transformers (with a second onnxruntime-node, onnxruntime-web and
# sharp) is imported only by LanceDB's own embedding functions; typescript is a
# types-only peer of @qdrant/js-client-rest; onnxruntime-node bundles every
# platform's binaries.
ARG TARGETARCH
RUN bun install --frozen-lockfile --production --filter '!@laplace.live/eidolon-sdk' \
 && bun pm cache rm \
 && ORT="$(echo node_modules/.bun/onnxruntime-node@1.30.*/node_modules/onnxruntime-node/bin/napi-v6)" \
 && rm -rf node_modules/.bun/@huggingface+transformers@* \
           node_modules/.bun/onnxruntime-node@1.19.* \
           node_modules/.bun/onnxruntime-web@* \
           node_modules/.bun/sharp@* \
           node_modules/.bun/@img+* \
           node_modules/.bun/typescript@* \
           node_modules/.bun/@typescript+typescript-* \
           "$ORT/darwin" "$ORT/win32" \
           "$ORT/linux/$(if [ "$TARGETARCH" = arm64 ]; then echo x64; else echo arm64; fi)"

# The persona templates ship in the image; a persona's index, private references and Mem0's
# history live in the data home, a volume mounted at /data (docs/personas.md).
ENV EIDOLON_HOME=/data
COPY personas ./personas
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/bot ./apps/bot

EXPOSE 7860

# exec, so bun is PID 1 and receives SIGTERM itself.
CMD ["sh", "-c", "exec bun --no-env-file apps/bot/src/main.ts --host \"$PIPECAT_HOST\" --port \"$PIPECAT_PORT\""]
