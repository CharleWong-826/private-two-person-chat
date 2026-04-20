FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=8088

EXPOSE 8088

CMD ["node", "server.js"]
