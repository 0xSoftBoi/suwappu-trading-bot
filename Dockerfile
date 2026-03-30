FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
HEALTHCHECK --interval=60s --timeout=5s CMD echo "ok" || exit 1
CMD ["bun", "run", "src/cli.ts"]
