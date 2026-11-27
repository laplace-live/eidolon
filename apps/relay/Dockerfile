# syntax=docker/dockerfile:1
# Blind Subspace E2EE Relay with stateless JWKS verification. Build context is the repo root.

FROM node:24-slim AS deps

ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app

COPY package.json ./
RUN corepack install && pnpm --version

COPY pnpm-workspace.yaml pnpm-lock.yaml ./

COPY apps/bot/package.json apps/bot/
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
COPY apps/eidolon/package.json apps/eidolon/
COPY apps/relay/package.json apps/relay/
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
COPY packages/subspace/package.json packages/subspace/
COPY packages/tools/package.json packages/tools/
COPY packages/turn/package.json packages/turn/
COPY packages/usage/package.json packages/usage/
COPY packages/voice/package.json packages/voice/
COPY packages/webrtc/package.json packages/webrtc/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /pnpm/store \
      --filter @eidolon/relay...

FROM node:24-slim

WORKDIR /app
COPY --from=deps /app ./

ENV NODE_ENV=production \
    EIDOLON_RELAY_HOST=0.0.0.0 \
    EIDOLON_RELAY_PORT=8788 \
    EIDOLON_RELAY_DB_PATH=/data/relay.sqlite \
    EIDOLON_RELAY_AUTH_ISSUER=https://id.laplace.live \
    EIDOLON_RELAY_AUTH_AUDIENCE=eidolon-relay

COPY packages/config ./packages/config
COPY packages/subspace ./packages/subspace
COPY apps/relay ./apps/relay

VOLUME ["/data"]
EXPOSE 8788

CMD ["sh", "-c", "exec node apps/relay/src/main.ts"]
