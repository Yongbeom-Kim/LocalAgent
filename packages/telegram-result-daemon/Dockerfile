FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/telegram-result-daemon/package.json packages/telegram-result-daemon/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/task-enrichment-daemon/package.json packages/task-enrichment-daemon/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/telegram-result-daemon

COPY packages/shared/ packages/shared/
COPY packages/telegram-result-daemon/ packages/telegram-result-daemon/

RUN cd packages/shared && npx tsc
RUN cd packages/telegram-result-daemon && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/telegram-result-daemon/package.json packages/telegram-result-daemon/package.json
COPY --from=builder /app/packages/telegram-result-daemon/dist/ packages/telegram-result-daemon/dist/
COPY --from=builder /app/packages/telegram-result-daemon/node_modules/ packages/telegram-result-daemon/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/telegram-result-daemon

CMD ["node", "dist/index.js"]
