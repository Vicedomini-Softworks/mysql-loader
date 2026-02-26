# MySQL Loader

A small **edge-style** HTTP service that loads a gzipped (or zipped) SQL backup into MySQL. Upload the file, it gets unzipped and piped into the database—easy peasy lemon squeezy—then you can tear down the service.

## What it does

1. **Accepts** an uploaded backup (gzip, tgz, zip, or raw `.sql`)
2. **Unzips** it into a temporary work directory
3. **Loads** the single `.sql` file into MySQL via the `mysql` CLI
4. **Done.** The service can then be deleted or scaled to zero.

The archive must contain **exactly one** `.sql` file.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- MySQL client CLI (`mysql`) and `unzip` / `tar` (for decompression)

### Run locally

```bash
bun install
bun run dev
```

### Upload a backup

```bash
# Using the included script (requires pv and curl)
bun run load path/to/backup.sql.gz

# Or with curl directly
curl -u USER:PASS -X POST --data-binary @backup.sql.gz http://localhost:3000/api/upload
```

Upload endpoint is protected with **HTTP Basic Auth**.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `UPLOAD_DIR` | Directory for incoming uploads | `./uploads` |
| `WORK_DIR` | Directory for extraction | `./work` |
| `MAX_BODY_SIZE` | Max request body size (bytes) | `10737418240` (10 GB) |
| `BASIC_AUTH_USER` | Basic Auth username | *required* |
| `BASIC_AUTH_PASS` | Basic Auth password | *required* |
| `MYSQL_HOST` | MySQL host | *required* |
| `MYSQL_PORT` | MySQL port | `3306` |
| `MYSQL_USER` | MySQL user | *required* |
| `MYSQL_PASSWORD` | MySQL password | *required* |
| `MYSQL_DATABASE` | Target database | *required* |

## Docker

Build and run:

```bash
docker build -t mysql-loader .
docker run -p 3000:3000 \
  -e BASIC_AUTH_USER=admin \
  -e BASIC_AUTH_PASS=secret \
  -e MYSQL_HOST=your-mysql-host \
  -e MYSQL_USER=user \
  -e MYSQL_PASSWORD=pass \
  -e MYSQL_DATABASE=dbname \
  mysql-loader
```

Then POST your gzipped backup to `http://localhost:3000/api/upload` with Basic Auth. Once the import finishes, you can stop and remove the container.

## API

- **`GET /api/health`** — Health check (no auth). Returns `{ "status": "ok" }`.
- **`POST /api/upload`** — Upload a backup (Basic Auth required). Body: raw file (`.gz`, `.tgz`, `.zip`, or `.sql`). Response: `{ "message": "Upload complete. SQL migration started." }`. Import runs asynchronously after the response.

## License

Unlicense.
