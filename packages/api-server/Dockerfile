FROM node:20-alpine AS builder
WORKDIR /app
COPY packages/shared/ packages/shared/
COPY packages/api-server/ packages/api-server/
RUN cd packages/shared && npm install && npm run build
RUN cd packages/api-server && npm install && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=builder /app/packages/api-server/dist/ packages/api-server/dist/
COPY --from=builder /app/packages/api-server/package.json packages/api-server/
COPY --from=builder /app/packages/api-server/node_modules/ packages/api-server/node_modules/
WORKDIR /app/packages/api-server
CMD ["node", "dist/index.js"]
