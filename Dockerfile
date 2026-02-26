# Official Bun runtime (includes Bun; no separate install needed)
FROM oven/bun:1-debian

# unzip for .zip and .gz uploads (mysql2 for DB, no CLI)
RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json ./
RUN bun install

# Copy application
COPY . .

EXPOSE 3000

# Run with Bun
CMD ["bun", "run", "start"]
