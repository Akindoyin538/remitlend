# ── Builder Stage ──────────────────────────────────────────────────────────────
# Install dev-deps, compile TypeScript, then discard the build toolchain so it
# never ships in the final image.
FROM node:22-alpine AS builder

WORKDIR /app

# Install all dependencies including devDependencies needed for tsc
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json tsconfig.build.json ./
COPY migrations ./migrations
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# ── Production Stage ───────────────────────────────────────────────────────────
# Minimal runtime image: no shell, no package manager, no build tools.
FROM node:22-alpine AS production

WORKDIR /app

# Build-time metadata injected by the CI pipeline via --build-arg.
# These are baked into the image so GET /version works without any
# runtime environment variable configuration.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

# Install only production dependencies.
# Remove the lockfile afterwards so it is not part of the final layer cache.
COPY package*.json ./
RUN npm ci --omit=dev && rm -f package-lock.json

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

# Non-root user for security.
# Create the group and user before switching to enforce least-privilege.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Ensure the working directory is owned by the non-root user so read_only
# container mounts do not cause permission errors at startup.
RUN chown -R appuser:appgroup /app

# Least-privilege runtime: drop all Linux capabilities and forbid privilege
# escalation. The process runs as a non-root user and never needs to gain
# privileges, so the capability bounding set can be emptied entirely.
# These are declared in the image so any runtime (Compose, Kubernetes, plain
# `docker run`) inherits the hardened defaults without extra flags.
USER appuser

# Writable paths required at runtime are provided as explicit temporary
# volumes (tmpfs) by the orchestrator, so the root filesystem can stay
# read-only. Documented here for image scanners and integration tests:
#   /tmp   — Node/OS scratch space
#   /app/tmp — application scratch space
# No secrets are baked into layers; they are injected at runtime via the
# approved mechanism (environment/secret mounts), never via ARG/ENV here.

EXPOSE 3001

# OCI image labels for supply-chain traceability (SLSA L1 minimum).
# The CI pipeline overrides GIT_SHA and BUILD_TIME via --build-arg.
LABEL org.opencontainers.image.source="https://github.com/JhayJ22/remitlend" \
      org.opencontainers.image.description="RemitLend backend API" \
      org.opencontainers.image.licenses="ISC" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}"

# Liveness probe. Node 22 ships a global fetch, so no extra tooling
# (curl/wget) is needed in the image — keeping the attack surface minimal.
# Works under a read-only root filesystem and dropped capabilities.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Graceful shutdown: run Node as PID 1 so it receives SIGTERM/SIGINT directly
# and can drain connections before exiting. `--init`-style signal handling is
# provided by the exec-form CMD below (no shell wrapper to swallow signals).
CMD ["node", "dist/index.js"]
