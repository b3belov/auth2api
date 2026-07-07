FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY package.json ./
EXPOSE 8317 1455 54545
VOLUME ["/root/.auth2api", "/config"]
ENV NODE_ENV=production
CMD ["node", "dist/index.js", "--config=/config/config.yaml"]
