import { Hono } from "hono";
import { cors } from "hono/cors";
import { basicAuth } from "hono/basic-auth";
import { createConnection } from "mysql2/promise";
import { mkdir, readdir } from "fs/promises";
import { existsSync, createWriteStream } from "fs";
import path from "path";

const PROGRESS_BAR_WIDTH = 32;
const PROGRESS_UPDATE_INTERVAL_MS = 150;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + " KB";
  return bytes + " B";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function renderProgressBar(
  bytesRead: number,
  totalBytes: number,
  startTime: number
): string {
  const pct = totalBytes > 0 ? bytesRead / totalBytes : 1;
  const filled = Math.min(
    PROGRESS_BAR_WIDTH,
    Math.round(pct * PROGRESS_BAR_WIDTH)
  );
  const bar =
    "=".repeat(filled) +
    (filled < PROGRESS_BAR_WIDTH ? ">" : "") +
    " ".repeat(PROGRESS_BAR_WIDTH - filled - (filled < PROGRESS_BAR_WIDTH ? 1 : 0));
  const pctStr = (pct * 100).toFixed(1);
  const elapsed = (Date.now() - startTime) / 1000;
  const speed = elapsed > 0 ? bytesRead / elapsed : 0;
  const eta = speed > 0 ? (totalBytes - bytesRead) / speed : 0;
  return [
    `[${bar}]`,
    `${pctStr}%`,
    `|`,
    `${formatBytes(bytesRead)} / ${formatBytes(totalBytes)}`,
    `|`,
    `${formatBytes(speed)}/s`,
    `|`,
    `ETA ${formatDuration(eta)}`,
  ].join(" ");
}

const app = new Hono({ strict: false });

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const WORK_DIR = process.env.WORK_DIR || "./work";
const PORT = process.env.PORT || 3000;
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || 10 * 1024 * 1024 * 1024;

console.log("MYSQL Loader is running on port", PORT);
console.log("UPLOAD_DIR:", UPLOAD_DIR);
console.log("WORK_DIR:", WORK_DIR);
console.log("MAX_BODY_SIZE:", MAX_BODY_SIZE);
console.log("MYSQL_HOST:", process.env.MYSQL_HOST);
console.log("MYSQL_DATABASE:", process.env.MYSQL_DATABASE);

for (const dir of [UPLOAD_DIR, WORK_DIR]) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

app.use("/*", cors());

app.use(
  "/api/upload",
  basicAuth({
    username: process.env.BASIC_AUTH_USER!,
    password: process.env.BASIC_AUTH_PASS!,
  })
);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.post("/api/upload", async (c) => {
  const filename = `upload-${Date.now()}`;
  const filePath = path.join(UPLOAD_DIR, filename);

  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: "No body stream" }, 400);

  const writeStream = createWriteStream(filePath);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writeStream.write(value);
  }

  writeStream.end();

  runSqlMigration(filePath);

  return c.json({ message: "Upload complete. SQL migration started." });
});

async function runSqlMigration(filePath: string) {
  try {
    console.log("Processing:", filePath);

    const extractDir = path.join(WORK_DIR, `job-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });

    // Detect compression
    if (filePath.endsWith(".zip")) {
      await Bun.spawn(["unzip", "-q", filePath, "-d", extractDir]).exited;
    } else if (filePath.endsWith(".gz") || filePath.endsWith(".tgz")) {
      await Bun.spawn(["tar", "-xzf", filePath, "-C", extractDir]).exited;
    } else {
      // assume raw sql
      await Bun.spawn(["cp", filePath, path.join(extractDir, "dump.sql")])
        .exited;
    }

    const files = await readdir(extractDir);
    const sqlFiles = files.filter((f) => f.endsWith(".sql"));

    if (sqlFiles.length !== 1) {
      throw new Error("Archive must contain exactly ONE .sql file");
    }

    const sqlPath = path.join(extractDir, sqlFiles[0]);

    const sqlFile = Bun.file(sqlPath);
    const totalBytes = sqlFile.size;
    console.log("Running SQL:", sqlPath, `(${formatBytes(totalBytes)})`);
    console.log("");

    const connection = await createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || "3306"),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      multipleStatements: true,
      ...(process.env.MYSQL_SSL_SELF_SIGNED === "1" ||
      process.env.MYSQL_SSL_SELF_SIGNED === "true"
        ? { ssl: { rejectUnauthorized: false } }
        : {}),
    });

    const startTime = Date.now();
    let bytesRead = 0;
    let lastLogTime = 0;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let buffer = "";

    const stream = sqlFile.stream();
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value as Uint8Array;
        bytesRead += chunk.length;
        buffer += decoder.decode(chunk);

        const now = Date.now();
        if (now - lastLogTime >= PROGRESS_UPDATE_INTERVAL_MS || bytesRead === totalBytes) {
          lastLogTime = now;
          process.stdout.write("\r" + renderProgressBar(bytesRead, totalBytes, startTime));
        }

        // Split on statement boundary (;\n or ;\r\n), execute complete statements
        const parts = buffer.split(/\s*;\s*\r?\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const stmt = part.trim();
          if (stmt.length > 0 && !stmt.startsWith("--")) {
            await connection.query(stmt + ";");
          }
        }
      }

      // Execute remaining buffer
      const remainder = buffer.trim();
      if (remainder.length > 0 && !remainder.startsWith("--")) {
        const stmt = remainder.endsWith(";") ? remainder : remainder + ";";
        await connection.query(stmt);
      }
    } finally {
      reader.releaseLock();
      await connection.end();
    }

    process.stdout.write("\r" + renderProgressBar(totalBytes, totalBytes, startTime) + "\n");

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(
      `SQL migration completed successfully in ${formatDuration(elapsed)} (${formatBytes(totalBytes / elapsed)}/s avg).`
    );
  } catch (err) {
    console.error("Migration failed:", err);
  }
}

Bun.serve({
  port: Number(PORT),
  fetch: app.fetch,
  maxRequestBodySize: Number(MAX_BODY_SIZE),
});
