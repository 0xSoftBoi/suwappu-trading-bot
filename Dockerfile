FROM oven/bun:1.3.14
WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

RUN mkdir -p /data && chown bun:bun /data
USER bun
CMD ["bun", "run", "src/cli.ts"]
