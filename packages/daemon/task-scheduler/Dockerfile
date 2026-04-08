FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
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
RUN rush install --to @local-agent/task-scheduler

COPY packages/shared/ packages/shared/
COPY packages/daemon/task-scheduler/ packages/daemon/task-scheduler/

RUN cd packages/shared && npx tsc
RUN cd packages/daemon/task-scheduler && npx tsc

FROM node:20-alpine

RUN apk add --no-cache ca-certificates wget \
  && wget -q -O /usr/local/bin/supercronic https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-amd64 \
  && chmod +x /usr/local/bin/supercronic

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/daemon/task-scheduler/package.json packages/daemon/task-scheduler/package.json
COPY --from=builder /app/packages/daemon/task-scheduler/dist/ packages/daemon/task-scheduler/dist/
COPY --from=builder /app/packages/daemon/task-scheduler/config/ packages/daemon/task-scheduler/config/
COPY --from=builder /app/packages/daemon/task-scheduler/node_modules/ packages/daemon/task-scheduler/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/daemon/task-scheduler

CMD ["node", "dist/index.js"]
