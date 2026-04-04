import { Hono } from "hono";
import { cors } from "hono/cors";
import { basicAuth } from "hono/basic-auth";
import { streamSSE } from "hono/streaming";
import { createConnection } from "mysql2/promise";
import { mkdir, readdir, rm } from "fs/promises";
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

// ── Job state & SSE broadcast ─────────────────────────────────────────────────

type JobState = "idle" | "running" | "done" | "failed";

interface JobEntry {
  id:       number;
  t:        number;
  type:     "log" | "error" | "progress" | "status";
  msg?:     string;
  state?:   JobState;
  progress?: { pct: number; done: number; total: number; speed: number; eta: number };
}

let   jobState: JobState = "idle";
let   jobFilePath: string | null = null;
let   jobEntryId = 0;
const JOB_RING_MAX = 400;
const jobRing: JobEntry[] = [];
const sseWaiters = new Set<() => void>();

// Persisted on every state change so an interrupted job can be detected on restart.
// Defined lazily because WORK_DIR is set later; we write via a closure.
function persistJobState() {
  try {
    const data = JSON.stringify({ state: jobState, filePath: jobFilePath, t: Date.now() });
    Bun.write(`${process.env.WORK_DIR || "./work"}/job-state.json`, data).catch(() => {});
  } catch {}
}

function emitJob(entry: Omit<JobEntry, "id" | "t">) {
  const e: JobEntry = { id: ++jobEntryId, t: Date.now(), ...entry } as JobEntry;
  if (e.type === "status" && e.state) {
    jobState = e.state;
    persistJobState();
  }
  jobRing.push(e);
  if (jobRing.length > JOB_RING_MAX) jobRing.shift();
  for (const w of sseWaiters) w();
  sseWaiters.clear();
}

function jobLog(msg: string)   { console.log(msg);   emitJob({ type: "log",   msg }); }
function jobError(msg: string) { console.error(msg); emitJob({ type: "error", msg }); }

// ─────────────────────────────────────────────────────────────────────────────

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
    #cleanup-btn {
      margin-top: .6rem; padding: .4rem 0;
      background: transparent; color: #6e7681; border: 1px solid #30363d; border-radius: 6px;
      font-size: .85rem; cursor: pointer; transition: color .2s, border-color .2s;
      width: 100%; max-width: 540px;
    }
    #cleanup-btn:hover { color: #f85149; border-color: #f85149; }
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
    nav { width: 100%; max-width: 540px; display: flex; justify-content: flex-end; margin-bottom: 1rem; }
    nav a { font-size: .85rem; color: #58a6ff; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    #pending-section { width: 100%; max-width: 540px; margin-bottom: 1rem; display: none; }
    #pending-section h2 { font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; margin-bottom: .4rem; }
    .prow {
      display: flex; align-items: center; gap: .5rem; padding: .35rem .6rem;
      background: #161b22; border: 1px solid #30363d; border-radius: 6px; margin-bottom: .3rem;
    }
    .prow-info { flex: 1; font-size: .82rem; }
    .prow-name { color: #e6edf3; font-family: ui-monospace, monospace; word-break: break-all; }
    .prow-chunks { color: #8b949e; font-size: .75rem; margin-top: .1rem; }
    .btn-resume-pick { padding: .22rem .65rem; border-radius: 4px; font-size: .78rem; cursor: pointer; border: 1px solid #d29922; background: transparent; color: #d29922; white-space: nowrap; }
    .btn-resume-pick:hover { background: #2a1f00; }
    .btn-discard { padding: .22rem .5rem; border-radius: 4px; font-size: .78rem; cursor: pointer; border: 1px solid #30363d; background: transparent; color: #6e7681; }
    .btn-discard:hover { color: #f85149; border-color: #f85149; }
  </style>
</head>
<body>
  <h1>MySQL Loader</h1>
  <nav><a href="/job">View job status \u2192</a></nav>

  <div id="pending-section">
    <h2>Pending uploads</h2>
    <div id="pending-list"></div>
  </div>

  <div id="drop-zone">
    <p>Drop a <code>.sql</code>, <code>.gz</code>, <code>.tgz</code>, or <code>.zip</code> backup here</p>
    <p>or <label for="file-input">browse to select a file</label></p>
    <input type="file" id="file-input" accept=".gz,.tgz,.zip,.sql">
    <div id="file-name"></div>
    <div id="file-size"></div>
    <div id="resume-note"></div>
  </div>

  <button id="upload-btn" disabled>Upload</button>
  <button id="cleanup-btn">Clear all uploads &amp; work files</button>

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

    // Show pending (interrupted) uploads from localStorage on page load
    function renderPendingUploads() {
      const section  = document.getElementById('pending-section');
      const list     = document.getElementById('pending-list');
      const entries  = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('mysql-loader::')) continue;
        try {
          const val  = JSON.parse(localStorage.getItem(key));
          const rest = key.slice('mysql-loader::'.length); // "filename::size"
          const sep  = rest.lastIndexOf('::');
          const filename = rest.slice(0, sep);
          const size     = Number(rest.slice(sep + 2));
          entries.push({ key, filename, size, uploadId: val.uploadId, totalChunks: val.totalChunks });
        } catch {}
      }
      if (!entries.length) { section.style.display = 'none'; return; }
      section.style.display = 'block';
      list.innerHTML = '';
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'prow';

        const info = document.createElement('div');
        info.className = 'prow-info';
        const nm = document.createElement('div');
        nm.className = 'prow-name';
        nm.textContent = entry.filename;
        const chunks = document.createElement('div');
        chunks.className = 'prow-chunks';
        chunks.textContent = fmt(entry.size) + ' \u00b7 upload ID: ' + entry.uploadId.slice(0, 8) + '\u2026 \u00b7 ' + entry.totalChunks + ' chunks total';
        info.appendChild(nm);
        info.appendChild(chunks);
        row.appendChild(info);

        const btnPick = document.createElement('button');
        btnPick.className = 'btn-resume-pick';
        btnPick.textContent = '\u21ba Select file to resume';
        btnPick.addEventListener('click', () => {
          // Pre-seed resumeState so pickFile() immediately detects it
          resumeState = { uploadId: entry.uploadId, totalChunks: entry.totalChunks, confirmedChunks: new Set() };
          fileInput.click();
        });
        row.appendChild(btnPick);

        const btnDiscard = document.createElement('button');
        btnDiscard.className = 'btn-discard';
        btnDiscard.title = 'Discard saved progress';
        btnDiscard.textContent = '\u2715';
        btnDiscard.addEventListener('click', () => {
          localStorage.removeItem(entry.key);
          row.remove();
          if (!list.children.length) section.style.display = 'none';
        });
        row.appendChild(btnDiscard);

        list.appendChild(row);
      }
    }

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

    document.getElementById('cleanup-btn').addEventListener('click', async () => {
      if (!confirm('Remove all chunks, partial uploads, and work files from the server?')) return;
      try {
        const res = await fetch('/api/cleanup', { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        statusEl.textContent = res.ok ? data.message : ('Cleanup failed: ' + (data.error || res.status));
        statusEl.className = res.ok ? 'ok' : 'err';
        if (res.ok) { localStorage.clear(); renderPendingUploads(); }
      } catch (err) {
        statusEl.textContent = 'Cleanup failed: ' + err.message;
        statusEl.className = 'err';
      }
    });

    // Show pending uploads on page load
    renderPendingUploads();

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
          xhr.setRequestHeader('X-Filename',     file.name);

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

const JOB_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MySQL Loader \u2014 Job</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d1117; color: #c9d1d9;
      height: 100dvh; display: flex; flex-direction: column; overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: .9rem; padding: .65rem 1.2rem;
      border-bottom: 1px solid #21262d; flex-shrink: 0;
    }
    header a { color: #58a6ff; text-decoration: none; font-size: .88rem; white-space: nowrap; }
    header a:hover { text-decoration: underline; }
    h1 { font-size: .95rem; font-weight: 600; color: #e6edf3; flex: 1; }
    #badge {
      font-size: .7rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
      padding: .18rem .5rem; border-radius: 10px; background: #21262d; color: #8b949e;
    }
    #badge.running { background: #1f3a5f; color: #58a6ff; animation: pulse 1.4s ease-in-out infinite; }
    #badge.done    { background: #1a3a2a; color: #3fb950; }
    #badge.failed  { background: #3a1a1a; color: #f85149; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
    #conn { font-size: .75rem; color: #484f58; white-space: nowrap; }
    #conn.ok { color: #3fb950; }

    #progress-wrap { flex-shrink: 0; padding: .6rem 1.2rem; border-bottom: 1px solid #21262d; display: none; }
    #progress-track { background: #21262d; border-radius: 4px; height: 6px; overflow: hidden; }
    #progress-fill  { height: 100%; background: #238636; width: 0%; transition: width .2s linear; border-radius: 4px; }
    #progress-stats { display: flex; gap: 1.2rem; margin-top: .35rem; font-size: .78rem; color: #8b949e; font-variant-numeric: tabular-nums; }

    /* Files panel */
    #files-panel { flex-shrink: 0; border-bottom: 1px solid #21262d; max-height: 200px; overflow-y: auto; }
    #files-hdr {
      display: flex; align-items: center; gap: .6rem; padding: .45rem 1.2rem;
      font-size: .78rem; color: #8b949e; cursor: pointer; user-select: none;
      position: sticky; top: 0; background: #0d1117; border-bottom: 1px solid #161b22;
    }
    #files-hdr:hover { color: #c9d1d9; }
    #files-hdr span:first-child { flex: 1; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    #files-hdr button { background: none; border: none; color: inherit; cursor: pointer; font-size: .9rem; padding: 0 .2rem; }
    #files-body { padding: .3rem 1.2rem .5rem; }
    .frow {
      display: flex; align-items: center; gap: .5rem; padding: .25rem 0;
      border-bottom: 1px solid #161b22; font-size: .8rem;
    }
    .frow:last-child { border: none; }
    .frow.interrupted { background: #1f1a0d; margin: 0 -1.2rem; padding-left: 1.2rem; padding-right: 1.2rem; }
    .fname { flex: 1; font-family: ui-monospace, monospace; color: #e6edf3; word-break: break-all; }
    .fsize { color: #8b949e; white-space: nowrap; }
    .fbadge { font-size: .65rem; background: #4a3000; color: #d29922; padding: .1rem .35rem; border-radius: 6px; white-space: nowrap; }
    .btn-sm {
      padding: .2rem .55rem; border-radius: 4px; font-size: .75rem; cursor: pointer;
      border: 1px solid #30363d; background: #161b22; color: #c9d1d9; white-space: nowrap;
    }
    .btn-sm:hover { background: #21262d; }
    .btn-drop { border-color: #d29922; color: #d29922; }
    .btn-drop:hover { background: #2a1f00; }
    .btn-del  { border-color: #f85149; color: #f85149; }
    .btn-del:hover { background: #3a1a1a; }
    #files-empty { padding: .4rem 0; font-size: .8rem; color: #484f58; }

    #log {
      flex: 1; overflow-y: auto; padding: .65rem 1.2rem;
      font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
      font-size: .8rem; line-height: 1.65;
    }
    .ln { white-space: pre-wrap; word-break: break-all; }
    .ln-log      { color: #c9d1d9; }
    .ln-error    { color: #f85149; }
    .ln-s-running { color: #58a6ff; }
    .ln-s-done    { color: #3fb950; }
    .ln-s-failed  { color: #f85149; }
    .ts { color: #484f58; user-select: none; }
  </style>
</head>
<body>
  <header>
    <a href="/">\u2190 Upload</a>
    <h1>Job Status</h1>
    <span id="badge">idle</span>
    <span id="conn">\u25cf disconnected</span>
  </header>

  <div id="progress-wrap">
    <div id="progress-track"><div id="progress-fill"></div></div>
    <div id="progress-stats">
      <span id="s-pct">0%</span>
      <span id="s-bytes">\u2014 / \u2014</span>
      <span id="s-speed">\u2014 /s</span>
      <span id="s-eta">ETA \u2014</span>
    </div>
  </div>

  <div id="files-panel">
    <div id="files-hdr">
      <span>Available files</span>
      <button id="files-refresh" title="Refresh">\u21bb</button>
    </div>
    <div id="files-body"><div id="files-empty">Loading\u2026</div></div>
  </div>

  <div id="log"></div>

  <script>
    const badge      = document.getElementById('badge');
    const connEl     = document.getElementById('conn');
    const progWrap   = document.getElementById('progress-wrap');
    const progFill   = document.getElementById('progress-fill');
    const sPct       = document.getElementById('s-pct');
    const sBytes     = document.getElementById('s-bytes');
    const sSpeed     = document.getElementById('s-speed');
    const sEta       = document.getElementById('s-eta');
    const log        = document.getElementById('log');
    const filesBody  = document.getElementById('files-body');
    const filesEmpty = document.getElementById('files-empty');

    let lastFile = null; // filename of last/interrupted migration

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
    function hhmm(ms) {
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }

    function setState(state) {
      badge.textContent = state;
      badge.className   = state;
      if (state === 'done') {
        progWrap.style.display = 'block';
        progFill.style.width = '100%';
        sPct.textContent = '100%';
        sEta.textContent = 'done';
      }
    }

    function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
    function scrollDown() { log.scrollTop = log.scrollHeight; }

    function renderEntry(e) {
      if (e.type === 'progress') {
        const p = e.progress;
        progWrap.style.display = 'block';
        progFill.style.width = (p.pct * 100).toFixed(1) + '%';
        sPct.textContent   = (p.pct * 100).toFixed(1) + '%';
        sBytes.textContent = fmt(p.done) + ' / ' + fmt(p.total);
        sSpeed.textContent = p.speed > 0 ? fmt(p.speed) + '/s' : '\u2014 /s';
        sEta.textContent   = 'ETA ' + fmtDur(p.eta);
        return;
      }
      const wasAtBottom = atBottom();
      const div = document.createElement('div');
      let cls = 'ln ';
      if      (e.type === 'status') cls += 'ln-s-' + (e.state || 'running');
      else if (e.type === 'error')  cls += 'ln-error';
      else                          cls += 'ln-log';
      div.className = cls;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = '[' + hhmm(e.t) + '] ';
      div.appendChild(ts);
      div.appendChild(document.createTextNode(e.msg || ''));
      log.appendChild(div);
      if (wasAtBottom) scrollDown();
    }

    // ── File list ──────────────────────────────────────────────────────────────

    async function loadFiles() {
      filesEmpty.textContent = 'Loading\u2026';
      // Remove old rows
      Array.from(filesBody.querySelectorAll('.frow')).forEach(r => r.remove());
      let files = [];
      try {
        const r = await fetch('/api/files', { credentials: 'include' });
        if (r.ok) ({ files } = await r.json());
      } catch {}
      filesEmpty.style.display = files.length ? 'none' : '';
      if (!files.length) { filesEmpty.textContent = 'No files available.'; return; }
      filesEmpty.textContent = '';
      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'frow' + (f.name === lastFile ? ' interrupted' : '');

        const nm = document.createElement('span');
        nm.className = 'fname';
        nm.textContent = f.name;
        row.appendChild(nm);

        if (f.name === lastFile) {
          const badge = document.createElement('span');
          badge.className = 'fbadge';
          badge.textContent = 'interrupted';
          row.appendChild(badge);
        }

        const sz = document.createElement('span');
        sz.className = 'fsize';
        sz.textContent = fmt(f.size);
        row.appendChild(sz);

        const btnDrop = document.createElement('button');
        btnDrop.className = 'btn-sm btn-drop';
        btnDrop.textContent = 'Drop \u0026 Load';
        btnDrop.title = 'Drop the configured database and reload from this file';
        btnDrop.addEventListener('click', () => runFile(f.name, true));
        row.appendChild(btnDrop);

        const btnLoad = document.createElement('button');
        btnLoad.className = 'btn-sm';
        btnLoad.textContent = 'Load';
        btnLoad.title = 'Run migration without dropping the database first';
        btnLoad.addEventListener('click', () => runFile(f.name, false));
        row.appendChild(btnLoad);

        const btnDel = document.createElement('button');
        btnDel.className = 'btn-sm btn-del';
        btnDel.textContent = '\u2715';
        btnDel.title = 'Delete this file from the server';
        btnDel.addEventListener('click', () => deleteFile(f.name, row));
        row.appendChild(btnDel);

        filesBody.appendChild(row);
      }
    }

    async function runFile(filename, dropFirst) {
      const action = dropFirst
        ? 'Drop the database and reload from "' + filename + '"?'
        : 'Run migration from "' + filename + '" (no drop)?';
      if (!confirm(action)) return;
      const r = await fetch('/api/job/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ filename, dropFirst }),
      });
      const data = await r.json();
      if (!r.ok) alert('Error: ' + (data.error || r.status));
    }

    async function deleteFile(filename, row) {
      if (!confirm('Delete "' + filename + '" from the server?')) return;
      const r = await fetch('/api/files/' + encodeURIComponent(filename), {
        method: 'DELETE', credentials: 'include',
      });
      if (r.ok) row.remove();
      else {
        const d = await r.json().catch(() => ({}));
        alert('Error: ' + (d.error || r.status));
      }
    }

    document.getElementById('files-refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      loadFiles();
    });

    // ── SSE ───────────────────────────────────────────────────────────────────

    let es = null;

    function connect() {
      connEl.textContent = '\u25cf connecting\u2026';
      connEl.className = '';
      es = new EventSource('/api/job/stream');

      es.onopen = () => {
        connEl.textContent = '\u25cf connected';
        connEl.className = 'ok';
      };

      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.type === 'init') {
          lastFile = data.lastFile || null;
          setState(data.state);
          log.innerHTML = '';
          for (const e of data.history) renderEntry(e);
          scrollDown();
          loadFiles();
        } else {
          renderEntry(data);
          if (data.type === 'status' && data.state) {
            setState(data.state);
            if (data.state === 'done' || data.state === 'failed') loadFiles();
          }
        }
      };

      es.onerror = () => {
        connEl.textContent = '\u25cf reconnecting\u2026';
        connEl.className = '';
        es.close();
        es = null;
        setTimeout(connect, 3000);
      };
    }

    connect();
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

// Detect interrupted job from previous run
try {
  const stateFile = Bun.file(`${WORK_DIR}/job-state.json`);
  if (await stateFile.exists()) {
    const saved = await stateFile.json() as { state: JobState; filePath: string | null };
    if (saved.state === "running" && saved.filePath) {
      jobFilePath = saved.filePath;
      const basename = saved.filePath.split(/[\\/]/).pop() ?? saved.filePath;
      jobLog(`⚠ Server restarted. Previous migration was interrupted: ${basename}`);
      emitJob({ type: "status", state: "failed", msg: "Migration interrupted by server restart." });
    }
  }
} catch {}

app.use("/*", cors());

const auth = basicAuth({
  username: process.env.BASIC_AUTH_USER!,
  password: process.env.BASIC_AUTH_PASS!,
  realm: "MySQL Loader",
});

app.use("/", auth);
app.use("/job", auth);
app.use("/api/upload", auth);
app.use("/api/upload/*", auth);
app.use("/api/cleanup", auth);
app.use("/api/job/*", auth);
app.use("/api/files", auth);
app.use("/api/files/*", auth);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/", (c) => c.html(UI_HTML));

app.get("/job", (c) => c.html(JOB_HTML));

app.get("/api/job/stream", (c) =>
  streamSSE(c, async (stream) => {
    const lastFile = jobFilePath ? jobFilePath.split(/[\\/]/).pop() ?? null : null;
    await stream.writeSSE({
      data: JSON.stringify({ type: "init", state: jobState, history: [...jobRing], lastFile }),
    });

    let cursor  = jobEntryId;
    let aborted = false;
    stream.onAbort(() => { aborted = true; });

    while (!aborted) {
      const newEntries = jobRing.filter((e) => e.id > cursor);
      if (newEntries.length > 0) {
        cursor = newEntries[newEntries.length - 1].id;
        for (const e of newEntries) {
          if (aborted) break;
          await stream.writeSSE({ data: JSON.stringify(e) });
        }
      }
      if (!aborted) {
        // Wait until a new event is emitted or 20 s heartbeat fires
        await new Promise<void>((resolve) => {
          let done = false;
          const wake = () => { if (!done) { done = true; resolve(); } };
          const timer = setTimeout(() => { sseWaiters.delete(wake); wake(); }, 20_000);
          sseWaiters.add(() => { clearTimeout(timer); wake(); });
        });
      }
    }
  })
);

// ── File management & manual job trigger ─────────────────────────────────────

function isSafeFilename(name: string) {
  return /^[\w.\-]+$/.test(name) && !name.includes("..");
}

app.get("/api/files", async (c) => {
  if (!existsSync(UPLOAD_DIR)) return c.json({ files: [] });
  const entries = await readdir(UPLOAD_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => {
      const p = path.join(UPLOAD_DIR, e.name);
      return { name: e.name, size: Bun.file(p).size };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  return c.json({ files });
});

app.delete("/api/files/:name", async (c) => {
  const name = c.req.param("name");
  if (!isSafeFilename(name)) return c.json({ error: "Invalid filename" }, 400);
  const filePath = path.join(UPLOAD_DIR, name);
  if (!existsSync(filePath)) return c.json({ error: "File not found" }, 404);
  await rm(filePath, { force: true });
  return c.json({ message: "Deleted." });
});

app.post("/api/job/run", async (c) => {
  if (jobState === "running") return c.json({ error: "A migration is already running." }, 409);
  const body = await c.req.json<{ filename: string; dropFirst?: boolean }>();
  const { filename, dropFirst = false } = body;
  if (!filename || !isSafeFilename(filename)) return c.json({ error: "Invalid filename" }, 400);
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!existsSync(filePath)) return c.json({ error: "File not found" }, 404);
  runSqlMigration(filePath, { dropFirst });
  return c.json({ message: "Migration started." });
});

// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/upload", async (c) => {
  const clientName = c.req.header("X-Filename") ?? "";
  const ext        = (clientName && isSafeFilename(clientName)) ? path.extname(clientName) : "";
  const filename   = `upload-${Date.now()}${ext}`;
  const filePath   = path.join(UPLOAD_DIR, filename);

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
  const clientName  = c.req.header("X-Filename") ?? "";

  if (
    !/^[\w-]+$/.test(uploadId) ||
    isNaN(chunkIndex) || isNaN(totalChunks) ||
    chunkIndex < 0 || chunkIndex >= totalChunks
  ) {
    return c.json({ error: "Invalid chunk metadata" }, 400);
  }

  const uploadDir = path.join(UPLOAD_DIR, uploadId);
  if (!existsSync(uploadDir)) await mkdir(uploadDir, { recursive: true });

  // Persist original filename so reassembly can use the correct extension
  if (clientName && isSafeFilename(clientName)) {
    const metaPath = path.join(uploadDir, "meta.json");
    if (!existsSync(metaPath)) {
      await Bun.write(metaPath, JSON.stringify({ filename: clientName }));
    }
  }

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

app.delete("/api/cleanup", async (c) => {
  let removed = 0;
  for (const dir of [UPLOAD_DIR, WORK_DIR]) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir);
    for (const entry of entries) {
      await rm(path.join(dir, entry), { recursive: true, force: true });
      removed++;
    }
  }
  console.log(`Cleanup: removed ${removed} entries from upload/work dirs.`);
  return c.json({ message: `Cleanup complete. ${removed} entries removed.` });
});

async function reassembleAndMigrate(uploadId: string, totalChunks: number) {
  const uploadDir = path.join(UPLOAD_DIR, uploadId);

  // Recover original filename (and its extension) saved during chunk upload
  let originalName = "";
  try {
    const meta = await Bun.file(path.join(uploadDir, "meta.json")).json() as { filename: string };
    if (isSafeFilename(meta.filename)) originalName = meta.filename;
  } catch {}
  const ext     = originalName ? path.extname(originalName) : ".bin";
  const outPath = path.join(UPLOAD_DIR, `${uploadId}${ext}`);

  jobLog(`Reassembling ${totalChunks} chunks for upload ${uploadId}…`);
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
  jobLog(`Reassembly complete: ${outPath}`);
  await runSqlMigration(outPath, {});
}

async function runSqlMigration(filePath: string, opts: { dropFirst?: boolean } = {}) {
  jobFilePath = filePath;
  emitJob({ type: "status", state: "running", msg: `Migration started: ${path.basename(filePath)}` });
  try {
    jobLog(`Processing: ${filePath}`);

    const extractDir = path.join(WORK_DIR, `job-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });

    // Detect compression by magic bytes (not file extension, since uploaded
    // files are stored without their original extension)
    const magic = Buffer.alloc(4);
    const fd = await import("fs").then(m => m.promises.open(filePath, "r"));
    await fd.read(magic, 0, 4, 0);
    await fd.close();
    const isGz  = magic[0] === 0x1f && magic[1] === 0x8b;
    const isZip = magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;

    if (isZip) {
      await Bun.spawn(["unzip", "-q", filePath, "-d", extractDir]).exited;
    } else if (isGz) {
      // Try tar first; if it fails (plain .gz, not .tar.gz) fall back to gunzip
      const tarProc = Bun.spawn(["tar", "-xzf", filePath, "-C", extractDir], { stderr: "pipe" });
      const tarExit = await tarProc.exited;
      if (tarExit !== 0) {
        // Plain gzip — decompress directly to dump.sql
        const gunzipProc = Bun.spawn(
          ["sh", "-c", `gunzip -c "${filePath}" > "${path.join(extractDir, "dump.sql")}"`]
        );
        await gunzipProc.exited;
      }
    } else {
      // assume raw sql
      await Bun.spawn(["cp", filePath, path.join(extractDir, "dump.sql")]).exited;
    }

    // Find the .sql file recursively (it may be nested inside a subdirectory)
    const findProc = Bun.spawn(["find", extractDir, "-name", "*.sql", "-type", "f"], { stdout: "pipe" });
    await findProc.exited;
    const foundText = await new Response(findProc.stdout).text();
    const sqlFiles = foundText.trim().split("\n").filter(Boolean);

    if (sqlFiles.length !== 1) {
      throw new Error(`Archive must contain exactly ONE .sql file (found ${sqlFiles.length})`);
    }

    const sqlPath = sqlFiles[0];

    const sqlFile = Bun.file(sqlPath);
    const totalBytes = sqlFile.size;
    jobLog(`Running SQL: ${sqlPath} (${formatBytes(totalBytes)})`);

    const sslOpts =
      process.env.MYSQL_SSL_SELF_SIGNED === "1" || process.env.MYSQL_SSL_SELF_SIGNED === "true"
        ? { ssl: { rejectUnauthorized: false } }
        : {};

    if (opts.dropFirst) {
      const db = process.env.MYSQL_DATABASE!;
      jobLog(`Dropping database "${db}"…`);
      const adminConn = await createConnection({
        host:     process.env.MYSQL_HOST,
        port:     Number(process.env.MYSQL_PORT || "3306"),
        user:     process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        multipleStatements: true,
        ...sslOpts,
      });
      await adminConn.query(`DROP DATABASE IF EXISTS \`${db}\``);
      await adminConn.query(`CREATE DATABASE \`${db}\``);
      await adminConn.end();
      jobLog(`Database "${db}" dropped and recreated.`);
    }

    const connection = await createConnection({
      host:     process.env.MYSQL_HOST,
      port:     Number(process.env.MYSQL_PORT || "3306"),
      user:     process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      multipleStatements: true,
      ...sslOpts,
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
          const elapsedSec = (now - startTime) / 1000;
          const speed = elapsedSec > 0 ? bytesRead / elapsedSec : 0;
          emitJob({
            type: "progress",
            progress: {
              pct:   totalBytes > 0 ? bytesRead / totalBytes : 1,
              done:  bytesRead,
              total: totalBytes,
              speed,
              eta:   speed > 0 ? (totalBytes - bytesRead) / speed : 0,
            },
          });
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
    const doneMsg = `SQL migration completed successfully in ${formatDuration(elapsed)} (${formatBytes(totalBytes / elapsed)}/s avg).`;
    console.log(doneMsg);
    emitJob({ type: "status", state: "done", msg: doneMsg });
  } catch (err) {
    const errMsg = `Migration failed: ${err}`;
    jobError(errMsg);
    emitJob({ type: "status", state: "failed", msg: errMsg });
  }
}

Bun.serve({
  port: Number(PORT),
  fetch: app.fetch,
  maxRequestBodySize: Number(MAX_BODY_SIZE),
});
