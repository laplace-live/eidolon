# syntax=docker/dockerfile:1
# The TypeScript bot. Its build context is the repo root, not apps/bot.
FROM oven/bun:1.4.4

WORKDIR /app

# Bun.serve defaults `development` to NODE_ENV !== "production", which answers an
# uncaught handler error with an HTML debug page instead of a plain 500.
ENV NODE_ENV=production \
    PIPECAT_HOST=0.0.0.0 \
    PIPECAT_PORT=7860

# Every workspace manifest, apps/cli's included: --frozen-lockfile fails when the
# workspace set differs from the one bun.lock records.
COPY package.json bun.lock ./
COPY apps/bot/package.json apps/bot/
COPY apps/cli/package.json apps/cli/
COPY packages/access/package.json packages/access/
COPY packages/config/package.json packages/config/
COPY packages/context/package.json packages/context/
COPY packages/core/package.json packages/core/
COPY packages/imagegen/package.json packages/imagegen/
COPY packages/memory/package.json packages/memory/
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/runtime/package.json packages/runtime/
COPY packages/tools/package.json packages/tools/
COPY packages/turn/package.json packages/turn/

# onnxruntime-node's postinstall stays blocked (Bun runs no untrusted lifecycle
# scripts): on linux/x64 it downloads the CUDA execution provider, and the CPU
# binaries already ship in the tarball. Never add it to trustedDependencies.
#
# The prune removes what the bot never loads. LanceDB's optional
# @huggingface/transformers (with a second onnxruntime-node, onnxruntime-web and
# sharp) is imported only by LanceDB's own embedding functions; typescript is a
# types-only peer of @qdrant/js-client-rest; onnxruntime-node bundles every
# platform's binaries.
ARG TARGETARCH
RUN bun install --frozen-lockfile --production \
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

# The *.lance files are Git LFS objects. A checkout without LFS copies pointer
# stubs, and both RAG tiers then switch themselves off at runtime.
COPY data/lancedb ./data/lancedb
RUN for f in $(find data/lancedb -type f -name '*.lance' -size -2k); do \
      if head -c 40 "$f" | grep -q '^version https://git-lfs'; then \
        echo "$f is a Git LFS pointer; check out with LFS" >&2; exit 1; \
      fi; \
    done
COPY data/selfie-references ./data/selfie-references
COPY persona.md tsconfig.json ./
COPY packages ./packages
COPY apps/bot ./apps/bot

EXPOSE 7860

# exec, so bun is PID 1 and receives SIGTERM itself.
CMD ["sh", "-c", "exec bun --no-env-file apps/bot/src/main.ts --host \"$PIPECAT_HOST\" --port \"$PIPECAT_PORT\""]
