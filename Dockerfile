FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# The app has zero runtime npm dependencies, so no npm install is required.
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /app/data /app/uploads /app/backups \
    && chown -R node:node /app/data /app/uploads /app/backups

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
