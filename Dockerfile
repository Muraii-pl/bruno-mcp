# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine
ARG BRUNO_CLI_VERSION=4
RUN apk add --no-cache git tini \
 && npm install -g @usebruno/cli@${BRUNO_CLI_VERSION} \
 && npm cache clean --force \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    BRU_BIN=bru \
    HOME=/data

USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/dist/server.js"]
