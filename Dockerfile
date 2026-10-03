# ============================================================================
#  ZAYN'S DC BOT - production image
#  Works on Koyeb, Fly.io, Railway, Render, plain Docker, anything OCI.
# ============================================================================
FROM node:20-alpine

# Small init so PID 1 reaps zombies and forwards SIGTERM (graceful shutdown).
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# ---- dependencies ----------------------------------------------------------
# Copy manifests first so the layer is cached unless dependencies change.
COPY package.json package-lock.json* ./

# `npm ci` when a lockfile is present (reproducible), otherwise fall back to
# `npm install` so a first-time clone without a lockfile still builds.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

# ---- application -----------------------------------------------------------
COPY . .

# Drop privileges - the alpine image already ships a `node` user.
RUN chown -R node:node /app
USER node

# Health-check endpoint port. Fly.io and Koyeb inject PORT themselves (fly.toml
# sets internal_port = 8080); when running this image locally map the port you
# set here (-p 8000:8000 -e PORT=8000). EXPOSE is documentation only - it does
# not publish anything by itself.
EXPOSE 8000 8080

# Entrypoint runs the bot; the optional health server binds the same process.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
