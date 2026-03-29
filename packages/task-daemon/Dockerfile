FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/task-daemon

COPY packages/shared/ packages/shared/
COPY packages/task-daemon/ packages/task-daemon/

RUN cd packages/shared && npx tsc
RUN cd packages/task-daemon && npx tsc

FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/task-daemon/package.json packages/task-daemon/package.json
COPY --from=builder /app/packages/task-daemon/dist/ packages/task-daemon/dist/
COPY --from=builder /app/packages/task-daemon/node_modules/ packages/task-daemon/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/task-daemon

CMD ["node", "dist/task-daemon.js"]
