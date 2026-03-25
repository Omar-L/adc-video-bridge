# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app

# Copy vendored dependency
COPY vendor/node-alarm-dot-com/ vendor/node-alarm-dot-com/

# Copy source
COPY package.json tsconfig.json ./
COPY src/ src/

# Update package.json to point to vendored dep for Docker context
RUN sed -i 's|"file:../node-alarm-dot-com"|"file:./vendor/node-alarm-dot-com"|' package.json

# Install deps (npm will symlink the file: dep into node_modules)
# Then copy the actual files to replace the symlink so it survives COPY
RUN npm install \
    && rm -rf node_modules/node-alarm-dot-com \
    && cp -r vendor/node-alarm-dot-com node_modules/node-alarm-dot-com

RUN npm run build

# Stage 2: Runtime — based on official go2rtc image (includes ffmpeg + go2rtc)
FROM alexxit/go2rtc:latest

# Install Node.js
RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 1984 8554

ENTRYPOINT ["./entrypoint.sh"]
