FROM ghcr.io/railwayapp/function-bun:1.3.0

# Switch to root to install packages
USER root

# Install mysql client only (Debian-based image)
RUN apt-get update && \
    apt-get install -y default-mysql-client && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Go back to bun user (important for Railway security model)
USER bun

WORKDIR /app

# Copy project files
COPY . .

# Install dependencies (if needed)
RUN bun install

EXPOSE 3000

CMD ["bun", "run", "index.tsx"]
