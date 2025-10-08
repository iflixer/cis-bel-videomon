# ---- Этап 1: сборка Node-зависимостей ----
FROM node:20-alpine AS build
WORKDIR /usr/src/app
COPY app/package*.json ./
RUN npm ci --omit=dev
COPY app/ .

# ---- Этап 2: рантайм: Node + PHP CLI ----
FROM node:20-alpine

# Устанавливаем только CLI-php и полезные расширения
# Подправь список экстеншенов под свои нужды
# RUN apk add --no-cache \
#       php82-cli \
#       php82-mbstring \
#       php82-curl \
#       php82-dom \
#       php82-simplexml \
#       php82-pdo_mysql \
#       php82-tokenizer \
#       php82-fileinfo \
#       composer

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    # иногда нужны:
    udev mesa-gl

WORKDIR /usr/src/app

COPY --from=build /usr/src/app ./

# Пути для puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_DOWNLOAD=true 

# EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "cronback"]