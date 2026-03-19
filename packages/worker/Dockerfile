FROM node:20-alpine AS builder
WORKDIR /app
COPY packages/shared/ packages/shared/
COPY packages/worker/ packages/worker/
RUN cd packages/shared && npm install && npm run build
RUN cd packages/worker && npm install && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=builder /app/packages/worker/dist/ packages/worker/dist/
COPY --from=builder /app/packages/worker/package.json packages/worker/
COPY --from=builder /app/packages/worker/node_modules/ packages/worker/node_modules/
WORKDIR /app/packages/worker
CMD ["node", "dist/main.js"]
