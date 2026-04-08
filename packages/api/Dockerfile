FROM node:20-alpine AS builder

WORKDIR /app

# Copy Rush config
COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Copy package manifests (Rush needs all projects listed in rush.json)
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/daemon/task/package.json packages/daemon/task/package.json
COPY packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
COPY packages/daemon/telegram-inbound/package.json packages/daemon/telegram-inbound/package.json
COPY packages/daemon/telegram-outbound/package.json packages/daemon/telegram-outbound/package.json
COPY packages/daemon/task-enrichment/package.json packages/daemon/task-enrichment/package.json
COPY packages/daemon/task-scheduler/package.json packages/daemon/task-scheduler/package.json
COPY packages/daemon/lark-listener/package.json packages/daemon/lark-listener/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/migrator/package.json packages/migrator/package.json

# Install Rush globally and run rush install
RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/api

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

# Build shared first, then api
RUN cd packages/shared && npx tsc
RUN cd packages/api && npx tsc

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/api/package.json packages/api/package.json
COPY --from=builder /app/packages/api/dist/ packages/api/dist/
COPY --from=builder /app/packages/api/node_modules/ packages/api/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/api

EXPOSE 3000

CMD ["node", "dist/index.js"]
