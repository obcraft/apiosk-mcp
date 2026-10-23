FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tini su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY index.mjs server.mjs server.json manifest.json dxt.json LICENSE ./
COPY bin ./bin
COPY src ./src
COPY assets ./assets
COPY plugin ./plugin
ENV NODE_ENV=production \
    PORT=3000 \
    APIOSK_MCP_HOST=0.0.0.0 \
    APIOSK_MCP_STATE_DIR=/data/state
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["/sbin/tini", "--"]
# Initialize only the configured journal directory, then drop privileges.
# Existing records are created by node and retain their private permissions.
CMD ["sh", "-c", "mkdir -p \"$APIOSK_MCP_STATE_DIR\" && chown node:node \"$APIOSK_MCP_STATE_DIR\" && chmod 700 \"$APIOSK_MCP_STATE_DIR\" && exec su-exec node node server.mjs"]
