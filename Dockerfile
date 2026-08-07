FROM oven/bun:1.3.14
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

RUN mkdir -p /data && chown bun:bun /data
ENV SUWAPPU_TRADING_BOT_STATE_DIR=/data
USER bun
VOLUME ["/data"]

# A container start performs one preview evaluation and exits. Continuous
# monitoring and managed execution must be selected explicitly by the operator.
CMD ["bun", "src/cli.ts", "--once", "--json"]
