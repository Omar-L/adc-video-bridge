# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/

RUN npm ci
RUN npm run build

# Stage 2: Runtime — based on official go2rtc image (includes ffmpeg + go2rtc)
FROM alexxit/go2rtc:1.9.14

# Install Node.js and create app directory with correct permissions
RUN apk add --no-cache nodejs npm && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && chown -R app:app /app

USER app

EXPOSE 1984 8554

ENTRYPOINT ["./entrypoint.sh"]
