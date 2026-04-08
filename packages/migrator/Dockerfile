FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests listed in rush.json.
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

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/migrator

COPY packages/shared/ packages/shared/
COPY packages/migrator/ packages/migrator/

RUN cd packages/shared && npx tsc
RUN cd packages/migrator && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/migrator/package.json packages/migrator/package.json
COPY --from=builder /app/packages/migrator/dist/ packages/migrator/dist/
COPY --from=builder /app/packages/migrator/src/migrations/ packages/migrator/dist/migrations/
COPY --from=builder /app/packages/migrator/node_modules/ packages/migrator/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/migrator

CMD ["node", "dist/index.js"]
