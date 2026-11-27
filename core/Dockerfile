# prina-core image — API + MCP + Admin static serving (T0.5 DoD: everything in one image)
# The admin build output is fetched by CI into admin-dist/ and included in the context (separate repo).
# Node 24 LTS (bookworm) — 2026-10-21 security release (CVE-2026-111497 Brotli RCE, TLS hostname
# bypasses). Node 20 is end-of-life and received no fix, so the base moved 20 → 24 in v0.5.16.
# Keep the major in step with prina-license/Dockerfile and the CI node-version.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
# onnxruntime-node (46-IMPL G3) downloads the 284 MB CUDA provider in its postinstall — this image is CPU only
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY packages ./packages
RUN pnpm build && pnpm prune --prod
# ONNX runtime (46-IMPL G3) — used by the EE invisible watermark only. The package ships the native
# library for every OS (~300 MB): keep this platform's (~46 MB), and remove the package altogether from
# an OSS build, which has no src/ee to use it.
RUN set -e; \
    ORT="$(find node_modules/.pnpm -maxdepth 3 -type d -path '*/onnxruntime-node@*/node_modules/onnxruntime-node' | head -1)"; \
    if [ -n "$ORT" ]; then \
      if [ -d src/ee ]; then \
        ARCH="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"; \
        rm -rf "$ORT"/bin/napi-v*/darwin "$ORT"/bin/napi-v*/win32; \
        for d in "$ORT"/bin/napi-v*/linux/*; do [ "$(basename "$d")" = "$ARCH" ] || rm -rf "$d"; done; \
        rm -f "$ORT"/bin/napi-v*/linux/*/libonnxruntime_providers_cuda.so "$ORT"/bin/napi-v*/linux/*/libonnxruntime_providers_tensorrt.so; \
      else \
        rm -rf node_modules/.pnpm/onnxruntime-node@* node_modules/.pnpm/onnxruntime-common@* node_modules/onnxruntime-node; \
      fi; \
    fi
# TrustMark model files (46-IMPL G3) — baked into the EE image so an installation never has to reach
# Adobe's host: fetched once here, at image build time, and checked against the SHA-256 pinned in the
# source. An OSS build has no EE code and gets an empty directory.
RUN set -e; mkdir -p models/trustmark; \
    if [ -d src/ee ]; then \
      node -e "import('./dist/src/ee/asset-protection/invisible.js').then((m) => m.ensureModels()).then((files) => console.log('trustmark models:', files.join(', ')))"; \
      printf 'TrustMark models (encoder_Q.onnx, decoder_Q.onnx)\nCopyright Adobe. MIT License — https://github.com/adobe/trustmark\n' > models/trustmark/NOTICE; \
    fi

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# TrustMark models for the EE invisible watermark (empty in an OSS image)
COPY --from=build /app/models ./models
COPY drizzle ./drizzle
COPY package.json ./
# @prina/shared — the node_modules symlink points at packages/shared, so place the compiled output there
# (in dev, tsx reads .ts directly, but prod node needs .js — fix main/exports to .js)
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/dist/packages/shared/src ./packages/shared/src
RUN sed -i 's|src/index\.ts|src/index.js|g' packages/shared/package.json
# admin build output (starts API-only if absent)
COPY admin-dist* ./admin-dist/
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
