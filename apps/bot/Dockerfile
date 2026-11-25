# syntax=docker/dockerfile:1
# The TypeScript bot. Its build context is the repo root, not apps/bot.

# pnpm installs the dependencies in a stage of their own, which keeps pnpm and its store out of the
# image. Both stages run on the target platform, so pnpm fetches the natives the image loads.
FROM node:24-slim AS deps

ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app

# pnpm's version comes from the root packageManager; this layer caches it and its native binary.
COPY package.json ./
RUN corepack install && pnpm --version

# Every workspace manifest, apps/cli's, apps/desktop's, apps/eidolon's and apps/web's included, so
# --frozen-lockfile checks each against pnpm-lock.yaml and fails on one that drifted.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/bot/package.json apps/bot/
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
COPY apps/eidolon/package.json apps/eidolon/
COPY apps/web/package.json apps/web/
COPY packages/access/package.json packages/access/
COPY packages/assistant/package.json packages/assistant/
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

# No install script runs: onnxruntime-node's would download the CUDA execution provider on
# linux/x64, and the CPU binaries already ship in the tarball.
#
# --filter skips the browser SDK's dependencies (its manifest is still checked against
# pnpm-lock.yaml). The prune removes what the bot never loads. LanceDB's optional
# @huggingface/transformers (with a second onnxruntime-node, onnxruntime-web and an older sharp and
# its libvips, matched below by version) is imported only by LanceDB's own embedding functions,
# while the bot's own sharp stays; typescript is a types-only peer of @qdrant/js-client-rest;
# onnxruntime-node bundles every platform's binaries.
ARG TARGETARCH
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /pnpm/store \
      --filter '!@laplace.live/eidolon-sdk' \
 && ORT="$(echo node_modules/.pnpm/onnxruntime-node@1.30.*/node_modules/onnxruntime-node/bin/napi-v6)" \
 && rm -rf node_modules/.pnpm/@huggingface+transformers@* \
           node_modules/.pnpm/onnxruntime-node@1.19.* \
           node_modules/.pnpm/onnxruntime-web@* \
           node_modules/.pnpm/sharp@0.33.* \
           node_modules/.pnpm/@img+sharp-*@0.33.* \
           node_modules/.pnpm/@img+sharp-libvips-*@1.0.* \
           node_modules/.pnpm/typescript@* \
           node_modules/.pnpm/@typescript+typescript-* \
           "$ORT/darwin" "$ORT/win32" \
           "$ORT/linux/$(if [ "$TARGETARCH" = arm64 ]; then echo x64; else echo arm64; fi)"

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    PIPECAT_HOST=0.0.0.0 \
    PIPECAT_PORT=7860

# The manifests and every node_modules folder pnpm made, the workspace packages' links included.
COPY --from=deps /app ./

# The persona templates ship in the image; a persona's index, private references and Mem0's
# history live in the data home, a volume mounted at /data (docs/personas.md).
ENV EIDOLON_HOME=/data
COPY personas ./personas
COPY packages ./packages
COPY apps/bot ./apps/bot

EXPOSE 7860

# exec, so node is PID 1 and receives SIGTERM itself.
CMD ["sh", "-c", "exec node apps/bot/src/main.ts --host \"$PIPECAT_HOST\" --port \"$PIPECAT_PORT\""]
