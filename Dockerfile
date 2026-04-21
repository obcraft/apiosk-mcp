FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.mjs server.mjs ./
COPY src ./src
EXPOSE 3000
CMD ["node", "server.mjs"]
