FROM node:20-alpine AS builder

WORKDIR /app

# Copy Rush config
COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Copy package manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json

# Install Rush globally and run rush install
RUN npm install -g @microsoft/rush@5.172.1
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
