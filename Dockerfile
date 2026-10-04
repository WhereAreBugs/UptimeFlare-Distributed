# Stage 1: Build
FROM node:22-bookworm-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package*.json ./
COPY worker/package*.json ./worker/

RUN npm ci --no-audit --no-fund
RUN cd worker && npm ci --no-audit --no-fund

# Copy all source files
COPY . .

# Build the Next.js application
RUN npx --no-install @cloudflare/next-on-pages

# Stage 2: Production
FROM node:22-bookworm-slim AS production

# tini forwards stop signals and reaps all Wrangler/workerd child processes.
RUN apt-get update && apt-get install -y --no-install-recommends bash curl tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy runtime dependencies from builder stage
COPY --from=builder /app/ /app/
COPY --from=builder /app/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false

# Expose the Pages port
EXPOSE 8788
VOLUME ["/app/.wrangler/state"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
    CMD code=$(curl -ks -o /dev/null -w '%{http_code}' "${UPTIMEFLARE_LOCAL_PROTOCOL:-http}://127.0.0.1:${UPTIMEFLARE_PAGES_PORT:-8788}/api/admin/config") && test "$code" = 401

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
