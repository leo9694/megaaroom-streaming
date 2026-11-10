const express = require("express");
const multer = require("multer");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { parseProcessing } = require("./processing-options");
if (require.main === module) process.env.MEDIA_THREADS ||= "4";
const { createSerialQueue } = require("./media-processing");

async function* walk(folder, relative = "") {
  for (const entry of await fsp.readdir(path.join(folder, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(folder, name);
    else yield name;
  }
}

async function sendPrepared(origin, job, root, onProgress) {
  const boundary = "MegaRoom" + crypto.randomBytes(20).toString("hex");
  const parts = [];
  const add = (field, file, filename, mime = "application/octet-stream") => parts.push({ field, file, filename: filename.replace(/["\r\n]/g, "_"), mime });
  for (let i = 0; i < job.files.length; i++) {
    const file = job.files[i];
    add(`source-${i}`, file.path, file.originalname, file.mimetype);
    for await (const relative of walk(path.join(root, "streams", job.entries[i].entryId))) {
      add(`asset-${i}:${relative}`, path.join(root, "streams", job.entries[i].entryId, relative), path.basename(relative));
    }
  }
  if (job.cover) add("cover", job.cover.path, job.cover.originalname, job.cover.mimetype);
  const manifest = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(job.analyses)}\r\n`);
  let total = manifest.length;
  for (const part of parts) {
    part.header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\nContent-Type: ${part.mime}\r\n\r\n`);
    total += part.header.length + (await fsp.stat(part.file)).size + 2;
  }
  const end = Buffer.from(`--${boundary}--\r\n`); total += end.length;
  async function* content() {
    let loaded = 0;
    yield manifest;
    for (const part of parts) {
      yield part.header;
      for await (const chunk of fs.createReadStream(part.file)) {
        loaded += chunk.length; onProgress(loaded, total); yield chunk;
      }
      yield Buffer.from("\r\n");
    }
    yield end;
  }
  const url = new URL(`/api/local-import/transfer/${job.ticket.id}`, origin);
  const http = require(url.protocol === "https:" ? "node:https" : "node:http");
  await new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": total,
      "X-Import-Token": job.ticket.token
    } }, (response) => {
      let result = "";
      response.on("data", (chunk) => { result = (result + chunk).slice(-65536); });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`VPS recusou o envio (${response.statusCode}): ${result.slice(0, 300)}`));
      });
    });
    request.on("error", reject);
    pipeline(Readable.from(content()), request).catch(reject);
  });
}

async function createHelper({ origin, root, key, engine }) {
  const app = express();
  const jobs = new Map();
  const queue = createSerialQueue();
  const jobsDir = path.join(root, "local-jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const persist = (job) => {
    const file = path.join(jobsDir, job.id + ".json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(job)); fs.renameSync(file + ".tmp", file);
  };
  for (const file of await fsp.readdir(jobsDir)) {
    if (!file.endsWith(".json")) continue;
    const job = JSON.parse(await fsp.readFile(path.join(jobsDir, file), "utf8"));
    if (!["done", "error"].includes(job.status)) {
      job.status = "error"; job.message = "Auxiliar reiniciado. Clique em tentar novamente.";
    }
    jobs.set(job.id, job);
  }
  app.use((req, res, next) => {
    if (req.get("host") !== "127.0.0.1:43123" && req.get("host") !== "localhost:43123" && process.env.NODE_ENV !== "test") return res.sendStatus(403);
    if (req.get("origin") !== origin) return res.sendStatus(403);
    res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type, X-Local-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Private-Network": "true", "Cache-Control": "no-store", "Vary": "Origin" });
    if (req.method === "OPTIONS") return res.sendStatus(204);
    if (req.get("x-local-key") !== key) return res.sendStatus(401);
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  const binaries = async () => {
    try {
      await execFile(require("ffmpeg-static"), ["-version"], { windowsHide: true });
      await execFile(require("ffprobe-static").path, ["-version"], { windowsHide: true });
      return true;
    } catch { return false; }
  };
  app.get("/health", async (req, res) => res.json({ ffmpeg: await binaries(), version: 1 }));
  const snapshot = (job) => ({ id: job.id, title: job.title, status: job.status, message: job.message,
    percent: job.percent || 0, loaded: job.loaded || 0, total: job.total || 0,
    processing: job.status === "processing" && job.current ? engine.getHlsSnapshot(job.current) : null });
  app.get("/jobs", (req, res) => res.json([...jobs.values()].map(snapshot)));
  const start = (job) => queue(async () => {
    try {
      job.status = "processing"; job.message = "Preparando video, audio e legendas no PC."; persist(job);
      job.analyses = [];
      for (const entry of job.entries) {
        job.current = entry.entryId;
        const analysis = await engine.analyzePlayback(entry);
        for (const track of analysis.audioTracks) {
          await engine.prepareVariant(entry, analysis, track.index, true);
        }
        for (const track of analysis.subtitleTracks.filter((track) => track.kind === "subtitles")) {
          await engine.prepareSubtitle(entry, analysis, track.index);
        }
        await engine.prepareHls(entry, analysis);
        if (engine.getHlsSnapshot(entry.entryId).status !== "ready") throw new Error("Escolha uma qualidade igual ou inferior ao video original.");
        const { sourcePath, ...metadata } = analysis;
        job.analyses.push(metadata);
      }
      job.status = "uploading"; job.message = "Enviando original e versoes prontas para a VPS."; persist(job);
      let last = 0;
      await sendPrepared(origin, job, root, (loaded, total) => {
        job.loaded = loaded; job.total = total; job.percent = Math.floor(loaded / total * 100);
        if (Date.now() - last > 2000) { persist(job); last = Date.now(); }
      });
      job.status = "done"; job.percent = 100; job.message = "Disponivel na biblioteca."; persist(job);
      await fsp.rm(path.join(root, "uploads", job.id), { recursive: true, force: true });
      for (const entry of job.entries) await fsp.rm(path.join(root, "streams", entry.entryId), { recursive: true, force: true });
    } catch (error) { job.status = "error"; job.message = error.message; persist(job); }
  });
  app.post("/jobs/:id/retry", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== "error") return res.sendStatus(409);
    job.status = "queued"; persist(job); start(job); res.json(snapshot(job));
  });
  app.post("/jobs", async (req, res, next) => {
    if (!await binaries()) return res.status(503).json({ error: "FFmpeg ausente. Execute novamente o instalador do auxiliar." });
    req.jobId = crypto.randomBytes(16).toString("hex"); next();
  }, multer({ storage: multer.diskStorage({
    destination(req, file, cb) { const folder = path.join(root, "uploads", req.jobId); fs.mkdirSync(folder, { recursive: true }); cb(null, folder); },
    filename(req, file, cb) { cb(null, crypto.randomBytes(8).toString("hex") + path.extname(file.originalname).replace(/[^\w.]/g, "")); }
  }), limits: { files: 101, fieldSize: 100000 } }).fields([{ name: "videos", maxCount: 100 }, { name: "cover", maxCount: 1 }]), async (req, res) => {
    try {
      const meta = JSON.parse(req.body.metadata);
      parseProcessing({ enabled: true, qualities: meta.qualities });
      if (!/^[a-f0-9]{48}$/.test(meta.ticket.id) || !/^[a-f0-9]{64}$/.test(meta.ticket.token)) throw new Error("Invalid ticket");
      const files = req.files.videos;
      if (!files?.length) throw new Error("Selecione os arquivos.");
      const body = { ...meta, processing: { enabled: true, qualities: meta.qualities } };
      const item = meta.kind === "series" ? engine.buildSeriesItem(files, body, null) : engine.buildMovieItem(files[0], body, null);
      const library = { items: [item] };
      const entries = (item.type === "movie" ? [item] : item.episodes).map((entry) => engine.findEntryById(library, entry.id));
      const job = { id: req.jobId, title: meta.title || files[0].originalname, ticket: meta.ticket, files, cover: req.files.cover?.[0], entries, status: "queued", message: "Na fila local." };
      jobs.set(job.id, job); persist(job); start(job); res.status(202).json(snapshot(job));
    } catch (error) { await fsp.rm(path.join(root, "uploads", req.jobId), { recursive: true, force: true }); res.status(400).json({ error: error.message }); }
  });
  app.use(async (error, req, res, next) => {
    if (req.jobId) await fsp.rm(path.join(root, "uploads", req.jobId), { recursive: true, force: true });
    res.status(400).json({ error: error.message });
  });
  return app;
}

if (require.main === module) (async () => {
  const origin = new URL(process.argv[2] || "http://localhost:3000").origin;
  const root = path.join(os.homedir(), ".megaaroom-local");
  fs.mkdirSync(root, { recursive: true });
  const keyFile = path.join(root, "pairing-key");
  const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  process.env.MEGAROOM_MEDIA_ROOT = root;
  process.env.MEDIA_THREADS ||= "4";
  const engine = require("./server");
  const app = await createHelper({ origin, root, key, engine });
  const server = app.listen(43123, "127.0.0.1", () => {
    console.log(`Auxiliar MegaRoom ativo para ${origin}\nCodigo para conectar no site: ${key}\nMantenha esta janela aberta durante o processamento e envio.`);
  });
  server.requestTimeout = 0;
})().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { createHelper, sendPrepared };
