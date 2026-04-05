FROM node:22-alpine
WORKDIR /app/subs/sdk-js
COPY subs/sdk-js/package.json subs/sdk-js/package-lock.json ./
COPY subs/sdk-js/index.mjs ./
RUN npm ci --omit=dev

WORKDIR /app/subs/mcp
COPY subs/mcp/package.json subs/mcp/package-lock.json ./
COPY subs/mcp/server.mjs subs/mcp/runtime.mjs ./
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["node", "server.mjs"]
