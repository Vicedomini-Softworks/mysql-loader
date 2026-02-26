import { Hono } from "hono";
import { cors } from "hono/cors";
import { basicAuth } from "hono/basic-auth";
import { mkdir, readdir } from "fs/promises";
import { existsSync, createWriteStream } from "fs";
import path from "path";

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

    console.log("Running SQL:", sqlPath);

    // Stream SQL file directly into mysql CLI
    const mysqlProcess = Bun.spawn({
      cmd: [
        "mysql",
        "-h",
        process.env.MYSQL_HOST!,
        "-P",
        process.env.MYSQL_PORT || "3306",
        "-u",
        process.env.MYSQL_USER!,
        `-p${process.env.MYSQL_PASSWORD}`,
        process.env.MYSQL_DATABASE!,
      ],
      stdin: Bun.file(sqlPath),
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await mysqlProcess.exited;

    if (exitCode !== 0) {
      throw new Error("MySQL import failed");
    }

    console.log("SQL migration completed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
  }
}

Bun.serve({
  port: Number(PORT),
  fetch: app.fetch,
  maxRequestBodySize: Number(MAX_BODY_SIZE),
});
