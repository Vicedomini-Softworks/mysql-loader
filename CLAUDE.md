# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # install dependencies
bun run dev          # run with hot reload (development)
bun run start        # run without hot reload
bun run build        # build to ./dist
bun run load <file>  # upload a file to the running local server (requires pv and curl)
```

There are no tests in this project.

## Architecture

This is a single-file Bun/TypeScript HTTP service (`index.tsx`) built on [Hono](https://hono.dev). Its sole purpose is to accept a gzipped/zipped/raw SQL backup via HTTP, extract it, and replay it into a MySQL database—then the service is discarded.

**Request flow:**

1. `POST /api/upload` — protected by HTTP Basic Auth (Hono middleware). The raw body is streamed to disk in `UPLOAD_DIR`.
2. `runSqlMigration()` fires asynchronously (after the HTTP response is sent). It:
   - Spawns `unzip` or `tar` via `Bun.spawn` to extract the archive into a timestamped subdirectory of `WORK_DIR`.
   - Finds the single `.sql` file (errors if there isn't exactly one).
   - Opens a `mysql2` promise connection with `multipleStatements: true`.
   - Streams the SQL file with `Bun.file().stream()`, splitting on `;\n` boundaries and executing each statement. Memory is bounded to the largest single statement.
   - Logs a live ASCII progress bar to stdout during the import.

**Key constraints / design decisions:**
- The archive must contain **exactly one** `.sql` file.
- Statement splitting uses `/\s*;\s*\r?\n/` — statements must end with `;\n`. Multi-line statements with embedded semicolons will misbehave.
- `load.sh` hardcodes `USER=admin` / `PASS=secret` — it is a local dev convenience script only.
- Docker image publishes to GHCR on every push to `main` and on releases (via `.github/workflows/docker.yml`).

## Environment variables

All required env vars must be set before starting the server. See the table in `README.md` for the full list. Key ones: `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`, `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
