# Stage 1: Build. Tags and multi-architecture digests are pinned so rebuilds
# cannot silently pull different base images.
FROM node:20.19.5-alpine3.22@sha256:6178e78b972f79c335df281f4b7674a2d85071aae2af020ffa39f0a770265435 AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# Stage 2: Runtime — based on official go2rtc image (includes ffmpeg + go2rtc)
FROM alexxit/go2rtc:1.9.14@sha256:675c318b23c06fd862a61d262240c9a63436b4050d177ffc68a32710d9e05bae

# Install only the runtime packages and create an unprivileged account.
RUN apk add --no-cache nodejs curl && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --chown=app:app --from=build /app/dist ./dist
COPY --chown=app:app --from=build /app/node_modules ./node_modules
COPY --chown=app:app --from=build /app/package.json ./
COPY --chown=app:app entrypoint.sh ./

ENV NODE_ENV=production

USER app

EXPOSE 1984 8554

ENTRYPOINT ["./entrypoint.sh"]
