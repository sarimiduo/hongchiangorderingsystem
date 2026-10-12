FROM node:20-alpine
WORKDIR /app
COPY server ./server
COPY public ./public
COPY package.json ./
ENV PORT=3000 KDS_MODE=mock
EXPOSE 3000
CMD ["node", "server/index.js"]
