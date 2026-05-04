# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the HostIT NestJS backend.
#
# Stage 1: install dependencies (cached separately from source)
# Stage 2: build the app (compiles TS → dist/, generates Prisma client)
# Stage 3: runtime image (slim, only prod deps + built artifacts)
#
# Render auto-detects Node and can deploy without this Dockerfile, but
# having one gives portability — same image runs on Fly, Railway, ECS,
# Kubernetes, etc.

# ---------- 1. dependencies ----------
FROM node:20-alpine AS deps
WORKDIR /app

# pnpm via corepack (bundled with Node 20)
RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- 2. build ----------
FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client + compile TypeScript.
RUN pnpm prisma generate
RUN pnpm build

# Strip dev dependencies for the runtime image.
RUN pnpm prune --prod

# ---------- 3. runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Non-root user for safety.
RUN addgroup -S nodeuser && adduser -S nodeuser -G nodeuser

COPY --from=build --chown=nodeuser:nodeuser /app/node_modules ./node_modules
COPY --from=build --chown=nodeuser:nodeuser /app/dist ./dist
COPY --from=build --chown=nodeuser:nodeuser /app/prisma ./prisma
COPY --from=build --chown=nodeuser:nodeuser /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=nodeuser:nodeuser /app/package.json ./package.json

USER nodeuser

# Render injects PORT; default to 3000 for local docker testing.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/main.js"]
