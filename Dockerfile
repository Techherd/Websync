# WebSync Self-Hosted
# Multi-stage build for production deployment

# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Copy all package files for workspace resolution
COPY package*.json ./
COPY packages/frontend/package*.json ./packages/frontend/
COPY packages/backend/package*.json ./packages/backend/

# Install all dependencies (needed for workspace resolution)
RUN npm ci

# Copy frontend source
COPY packages/frontend/ ./packages/frontend/

# Build frontend
WORKDIR /app/packages/frontend
RUN npm run build

# Stage 2: Build Backend
FROM node:20-alpine AS backend-builder

WORKDIR /app

# Copy all package files for workspace resolution
COPY package*.json ./
COPY packages/frontend/package*.json ./packages/frontend/
COPY packages/backend/package*.json ./packages/backend/

# Install all dependencies
RUN npm ci

# Copy backend source
COPY packages/backend/ ./packages/backend/

# Generate Prisma client and build
WORKDIR /app/packages/backend
RUN npx prisma generate
RUN npm run build

# Stage 3: Production Image
FROM node:20-alpine AS production

# Install rsync, openssh, docker-cli, curl (for healthcheck)
RUN apk add --no-cache rsync openssh-client docker-cli openssl curl

WORKDIR /app

# Copy backend build artifacts
COPY --from=backend-builder /app/packages/backend/dist ./dist
COPY --from=backend-builder /app/packages/backend/prisma ./prisma
COPY --from=backend-builder /app/packages/backend/package.json ./

# Copy node_modules from the backend workspace (includes all dependencies)
COPY --from=backend-builder /app/packages/backend/node_modules ./node_modules

# Also copy root node_modules for hoisted dependencies
COPY --from=backend-builder /app/node_modules ./root_node_modules

# Merge hoisted dependencies
RUN cp -rn ./root_node_modules/* ./node_modules/ 2>/dev/null || true && rm -rf ./root_node_modules

# Copy built frontend to serve statically
COPY --from=frontend-builder /app/packages/frontend/dist ./public

# Create data directory for SQLite
RUN mkdir -p /data

# Environment variables (override these in docker-compose or -e flags)
ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/websync.db"

# Expose port
EXPOSE 3000

# Health check (curl -f fails on HTTP 4xx/5xx)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start command - sync database schema then start server
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
