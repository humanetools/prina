# prina-core image — API + MCP + Admin static serving (T0.5 DoD: everything in one image)
# The admin build output is fetched by CI into admin-dist/ and included in the context (separate repo).
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY packages ./packages
RUN pnpm build && pnpm prune --prod

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# cloudflared (IMPL-public-tunnel) — core runs it as a supervised child process to expose
# the local install on *.prina.app. Pinned; bump deliberately, in a minor release only.
ARG CLOUDFLARED_VERSION=2026.8.2
ARG TARGETARCH=amd64
ADD https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH} /usr/local/bin/cloudflared
RUN chmod 755 /usr/local/bin/cloudflared
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
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
