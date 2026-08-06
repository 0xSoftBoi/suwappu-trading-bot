FROM oven/bun:1.3.14
WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

USER bun
CMD ["bun", "run", "src/cli.ts"]
