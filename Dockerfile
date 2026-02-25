FROM ghcr.io/railwayapp/function-bun:1.3.0

# Passa a root per installare pacchetti
USER root

# Installa client MySQL
RUN apt-get update && \
    apt-get install -y default-mysql-client && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia progetto
COPY . .

# Installa dipendenze come root
RUN bun install

# Torna a bun per runtime (opzionale)
USER bun

EXPOSE 3000

CMD ["bun", "run", "index.tsx"]
