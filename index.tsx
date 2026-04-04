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

const UI_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MySQL Loader</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d1117; color: #c9d1d9;
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 2rem;
    }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 2rem; color: #58a6ff; letter-spacing: .02em; }
    #drop-zone {
      border: 2px dashed #30363d; border-radius: 10px;
      padding: 3rem 2rem; text-align: center; cursor: pointer;
      transition: border-color .2s, background .2s;
      width: 100%; max-width: 540px;
    }
    #drop-zone.drag-over { border-color: #58a6ff; background: #161b22; }
    #drop-zone.has-file  { border-color: #3fb950; }
    #drop-zone p { color: #8b949e; line-height: 1.7; }
    #drop-zone label { color: #58a6ff; cursor: pointer; text-decoration: underline; }
    #file-input { display: none; }
    #file-name  { margin-top: .75rem; font-weight: 600; color: #e6edf3; word-break: break-all; }
    #file-size  { margin-top: .2rem; font-size: .85rem; color: #8b949e; }
    #resume-note { margin-top: .5rem; font-size: .82rem; color: #d29922; }
    #upload-btn {
      margin-top: 1.5rem; padding: .65rem 0;
      background: #238636; color: #fff; border: none; border-radius: 6px;
      font-size: 1rem; cursor: pointer; transition: background .2s;
      width: 100%; max-width: 540px;
    }
    #upload-btn:hover:not(:disabled) { background: #2ea043; }
    #upload-btn:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
    #progress-wrap { margin-top: 1.5rem; width: 100%; max-width: 540px; display: none; }
    #progress-track { background: #21262d; border-radius: 4px; height: 8px; overflow: hidden; }
    #progress-fill  { height: 100%; background: #238636; width: 0%; transition: width .15s linear; border-radius: 4px; }
    #progress-stats {
      display: flex; justify-content: space-between; flex-wrap: wrap; gap: .25rem;
      margin-top: .5rem; font-size: .8rem; color: #8b949e; font-variant-numeric: tabular-nums;
    }
    #status { margin-top: 1.5rem; font-size: .9rem; max-width: 540px; text-align: center; min-height: 1.4em; }
    .ok  { color: #3fb950; }
    .err { color: #f85149; }
    code { font-family: ui-monospace, monospace; font-size: .9em; }
  </style>
</head>
<body>
  <h1>MySQL Loader</h1>

  <div id="drop-zone">
    <p>Drop a <code>.sql</code>, <code>.gz</code>, <code>.tgz</code>, or <code>.zip</code> backup here</p>
    <p>or <label for="file-input">browse to select a file</label></p>
    <input type="file" id="file-input" accept=".gz,.tgz,.zip,.sql">
    <div id="file-name"></div>
    <div id="file-size"></div>
    <div id="resume-note"></div>
  </div>

  <button id="upload-btn" disabled>Upload</button>

  <div id="progress-wrap">
    <div id="progress-track"><div id="progress-fill"></div></div>
    <div id="progress-stats">
      <span id="s-pct">0%</span>
      <span id="s-bytes">— / —</span>
      <span id="s-speed">— /s</span>
      <span id="s-eta">ETA —</span>
    </div>
  </div>

  <div id="status"></div>

  <script>
    const CHUNK_SIZE = 256 * 1024 * 1024; // 256 MB

    const dropZone    = document.getElementById('drop-zone');
    const fileInput   = document.getElementById('file-input');
    const uploadBtn   = document.getElementById('upload-btn');
    const progWrap    = document.getElementById('progress-wrap');
    const progFill    = document.getElementById('progress-fill');
    const sPct        = document.getElementById('s-pct');
    const sBytes      = document.getElementById('s-bytes');
    const sSpeed      = document.getElementById('s-speed');
    const sEta        = document.getElementById('s-eta');
    const statusEl    = document.getElementById('status');
    const fileNameEl  = document.getElementById('file-name');
    const fileSizeEl  = document.getElementById('file-size');
    const resumeNote  = document.getElementById('resume-note');

    let selectedFile = null;
    let resumeState  = null; // { uploadId, totalChunks, confirmedChunks: Set }

    function fmt(b) {
      if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
      if (b >= 1e6) return (b / 1e6).toFixed(2) + ' MB';
      if (b >= 1e3) return (b / 1e3).toFixed(2) + ' KB';
      return b + ' B';
    }
    function fmtDur(s) {
      if (!isFinite(s) || s <= 0) return '\u2014';
      if (s < 60) return Math.round(s) + 's';
      return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    }
    function storageKey(f) { return 'mysql-loader::' + f.name + '::' + f.size; }

    async function checkResume(file) {
      const raw = localStorage.getItem(storageKey(file));
      if (!raw) return null;
      let saved; try { saved = JSON.parse(raw); } catch { return null; }
      const { uploadId, totalChunks } = saved;
      if (!uploadId || !totalChunks) return null;
      try {
        const r = await fetch('/api/upload/resume/' + uploadId, { credentials: 'include' });
        if (!r.ok) return null;
        const { chunks } = await r.json();
        if (!chunks.length) return null;
        return { uploadId, totalChunks, confirmedChunks: new Set(chunks) };
      } catch { return null; }
    }

    async function pickFile(file) {
      selectedFile = file;
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = fmt(file.size);
      dropZone.classList.add('has-file');
      dropZone.classList.remove('drag-over');
      statusEl.textContent = '';
      statusEl.className = '';
      resumeNote.textContent = '';
      uploadBtn.textContent = 'Upload';
      uploadBtn.disabled = false;

      resumeState = await checkResume(file);
      if (resumeState) {
        const done  = resumeState.confirmedChunks.size;
        const total = resumeState.totalChunks;
        resumeNote.textContent = '\u21ba Resume available: ' + done + '\u202f/\u202f' + total + ' chunks already on server.';
        uploadBtn.textContent = 'Resume Upload';
      }
    }

    dropZone.addEventListener('click', (e) => { if (!e.target.closest('label')) fileInput.click(); });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); });
    dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) pickFile(f);
    });

    uploadBtn.addEventListener('click', startUpload);

    async function startUpload() {
      if (!selectedFile) return;
      uploadBtn.disabled = true;
      progWrap.style.display = 'block';
      statusEl.className = '';

      const file        = selectedFile;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const uploadId    = resumeState ? resumeState.uploadId : crypto.randomUUID();

      localStorage.setItem(storageKey(file), JSON.stringify({ uploadId, totalChunks }));

      const confirmed   = resumeState ? new Set(resumeState.confirmedChunks) : new Set();
      const alreadyDone = confirmed.size * CHUNK_SIZE;
      let   uploadedBytes = alreadyDone;
      const startTime   = Date.now();

      // inChunk: bytes of the current chunk already sent (from XHR progress)
      function updateProgress(inChunk) {
        const done  = Math.min(uploadedBytes + inChunk, file.size);
        const pct   = file.size > 0 ? done / file.size : 1;
        const elapsed = (Date.now() - startTime) / 1000;
        const newBytes = done - alreadyDone;
        const speed = elapsed > 0 && newBytes > 0 ? newBytes / elapsed : 0;
        const eta   = speed > 0 ? (file.size - done) / speed : Infinity;
        progFill.style.width = (pct * 100).toFixed(1) + '%';
        sPct.textContent   = (pct * 100).toFixed(1) + '%';
        sBytes.textContent = fmt(done) + ' / ' + fmt(file.size);
        sSpeed.textContent = speed > 0 ? fmt(speed) + '/s' : '\u2014 /s';
        sEta.textContent   = 'ETA ' + fmtDur(eta);
      }

      updateProgress(0);

      // XHR-based chunk sender: streams the Blob directly from disk and
      // fires upload progress events (fetch does neither for large payloads).
      function sendChunk(chunkBlob, chunkIdx, onProgress) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/upload/chunk');
          xhr.withCredentials = true;
          xhr.setRequestHeader('X-Upload-Id',    uploadId);
          xhr.setRequestHeader('X-Chunk-Index',  String(chunkIdx));
          xhr.setRequestHeader('X-Total-Chunks', String(totalChunks));

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) onProgress(e.loaded);
          });

          xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
              let data; try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
              resolve(data);
            } else {
              let msg = 'HTTP ' + xhr.status;
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
              reject(Object.assign(new Error(msg), { status: xhr.status }));
            }
          });
          xhr.addEventListener('error', () => reject(new Error('Network error')));
          xhr.addEventListener('abort', () => reject(new Error('Aborted')));

          xhr.send(chunkBlob);
        });
      }

      for (let i = 0; i < totalChunks; i++) {
        if (confirmed.has(i)) continue;

        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        statusEl.textContent = 'Uploading chunk ' + (i + 1) + '\u202f/\u202f' + totalChunks + '\u2026';

        let lastErr = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) {
            const wait = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
            statusEl.textContent = 'Network error \u2014 retrying chunk ' + (i + 1) + '/' + totalChunks +
              ' (attempt ' + (attempt + 1) + '/4) in ' + (wait / 1000) + 's\u2026';
            await new Promise(r => setTimeout(r, wait));
            statusEl.textContent = 'Retrying chunk ' + (i + 1) + '\u202f/\u202f' + totalChunks + '\u2026';
          }
          try {
            const data = await sendChunk(chunk, i, (loaded) => updateProgress(loaded));

            if (data.status === 401) {
              statusEl.textContent = 'Authentication failed. Reload the page to re-enter credentials.';
              statusEl.className = 'err';
              resumeState = { uploadId, totalChunks, confirmedChunks: confirmed };
              uploadBtn.textContent = 'Resume Upload';
              uploadBtn.disabled = false;
              return;
            }

            confirmed.add(i);
            uploadedBytes += chunk.size;
            updateProgress(0);

            if (data.complete) {
              localStorage.removeItem(storageKey(file));
              progFill.style.width = '100%';
              sPct.textContent = '100%';
              sEta.textContent = 'done';
              statusEl.textContent = 'Upload complete \u2014 migration is running on the server. Check server logs for progress.';
              statusEl.className = 'ok';
              return;
            }
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
          }
        }

        if (lastErr) {
          statusEl.textContent = 'Failed after 4 attempts on chunk ' + (i + 1) + '/' + totalChunks +
            ': ' + lastErr.message + '. Click \u201cResume Upload\u201d to retry.';
          statusEl.className = 'err';
          resumeNote.textContent = '\u21ba ' + confirmed.size + '\u202f/\u202f' + totalChunks + ' chunks saved \u2014 you can resume.';
          resumeState = { uploadId, totalChunks, confirmedChunks: confirmed };
          uploadBtn.textContent = 'Resume Upload';
          uploadBtn.disabled = false;
          return;
        }
      }
    }
  </script>
</body>
</html>`;

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

const auth = basicAuth({
  username: process.env.BASIC_AUTH_USER!,
  password: process.env.BASIC_AUTH_PASS!,
  realm: "MySQL Loader",
});

app.use("/", auth);
app.use("/api/upload", auth);
app.use("/api/upload/*", auth);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/", (c) => c.html(UI_HTML));

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

app.get("/api/upload/resume/:uploadId", async (c) => {
  const uploadId = c.req.param("uploadId");
  if (!/^[\w-]+$/.test(uploadId)) return c.json({ error: "Invalid upload ID" }, 400);
  const uploadDir = path.join(UPLOAD_DIR, uploadId);
  if (!existsSync(uploadDir)) return c.json({ chunks: [] });
  const files = await readdir(uploadDir);
  const chunks = files
    .filter((f) => /^chunk-\d+$/.test(f))
    .map((f) => parseInt(f.slice(6), 10))
    .sort((a, b) => a - b);
  return c.json({ chunks });
});

app.post("/api/upload/chunk", async (c) => {
  const uploadId    = c.req.header("X-Upload-Id") ?? "";
  const chunkIndex  = parseInt(c.req.header("X-Chunk-Index") ?? "", 10);
  const totalChunks = parseInt(c.req.header("X-Total-Chunks") ?? "", 10);

  if (
    !/^[\w-]+$/.test(uploadId) ||
    isNaN(chunkIndex) || isNaN(totalChunks) ||
    chunkIndex < 0 || chunkIndex >= totalChunks
  ) {
    return c.json({ error: "Invalid chunk metadata" }, 400);
  }

  const uploadDir = path.join(UPLOAD_DIR, uploadId);
  if (!existsSync(uploadDir)) await mkdir(uploadDir, { recursive: true });

  const chunkPath = path.join(uploadDir, `chunk-${chunkIndex}`);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: "No body stream" }, 400);

  const ws = createWriteStream(chunkPath);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    ws.write(value);
  }
  await new Promise<void>((resolve) => ws.end(resolve));

  const files    = await readdir(uploadDir);
  const received = files.filter((f) => /^chunk-\d+$/.test(f)).length;

  if (received === totalChunks) {
    reassembleAndMigrate(uploadId, totalChunks);
    return c.json({ complete: true, message: "All chunks received. Migration started." });
  }

  return c.json({ complete: false, received, total: totalChunks });
});

async function reassembleAndMigrate(uploadId: string, totalChunks: number) {
  const uploadDir = path.join(UPLOAD_DIR, uploadId);
  const outPath   = path.join(UPLOAD_DIR, `${uploadId}.bin`);
  console.log(`Reassembling ${totalChunks} chunks for upload ${uploadId}…`);
  const ws = createWriteStream(outPath);
  for (let i = 0; i < totalChunks; i++) {
    const data = await Bun.file(path.join(uploadDir, `chunk-${i}`)).arrayBuffer();
    await new Promise<void>((resolve, reject) =>
      ws.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()))
    );
  }
  await new Promise<void>((resolve, reject) =>
    ws.end((err: Error | null) => (err ? reject(err) : resolve()))
  );
  console.log(`Reassembly complete: ${outPath}`);
  await runSqlMigration(outPath);
}

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
