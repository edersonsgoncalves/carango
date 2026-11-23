FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY db.js server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_DRIVER=sqlite \
    DB_PATH=/app/data/carango.db

RUN mkdir -p /app/data

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
