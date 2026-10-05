FROM node:22-alpine
ENV NODE_ENV=production CACHE_DIR=/app/.cache
WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json server.js player.html ./
COPY --chown=node:node game ./game
# Unzip + brotli-compress the game now, so the container starts instantly and serves the smallest files.
RUN node server.js --prepare

EXPOSE 8080
CMD ["node", "server.js"]
