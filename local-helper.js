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
const { createResourceMonitor } = require("./resource-monitor");
if (require.main === module) process.env.MEDIA_THREADS ||= "4";
const { createSerialQueue, withMediaPolicy, localProfiles } = require("./media-processing");

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
    if (!job.remote) add(`source-${i}`, file.path, file.originalname, file.mimetype);
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
  const url = new URL(`/api/local-import/transfer/${job.remote ? "existing/" : ""}${job.ticket.id}`, origin);
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

async function downloadOriginal(origin, job, root, onProgress) {
  const folder = path.join(root, "uploads", job.id); fs.mkdirSync(folder, { recursive: true });
  const ext = path.extname(job.remote.filename).replace(/[^\w.]/g, "") || ".mp4";
  const file = path.join(folder, "source" + ext);
  const url = new URL(`/api/local-import/transfer/existing/${job.ticket.id}/source`, origin);
  const http = require(url.protocol === "https:" ? "node:https" : "node:http");
  await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { "X-Import-Token": job.ticket.token } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Nao foi possivel baixar o original (${response.statusCode}).`)); return; }
      const total = Number(response.headers["content-length"]) || 0;
      let loaded = 0;
      response.on("data", (chunk) => { loaded += chunk.length; onProgress(loaded, total); });
      pipeline(response, fs.createWriteStream(file + ".part"))
        .then(() => fsp.rename(file + ".part", file)).then(resolve, reject);
    });
    request.on("error", reject);
  });
  return { path: file, originalname: job.remote.filename, mimetype: "application/octet-stream", size: (await fsp.stat(file)).size };
}

async function cancelRemote(origin, job) {
  if (!job.remote) return;
  const url = new URL(`/api/local-import/transfer/existing/${job.ticket.id}/cancel`, origin);
  const http = require(url.protocol === "https:" ? "node:https" : "node:http");
  await new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers: { "X-Import-Token": job.ticket.token } }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode < 300 || [403, 404].includes(response.statusCode) ? resolve() : reject(new Error("Nao foi possivel liberar a otimizacao na VPS.")));
    }); request.on("error", reject); request.end();
  });
}

async function createHelper({ origin, root, key, engine }) {
  const app = express();
  const jobs = new Map();
  const queue = createSerialQueue();
  const jobsDir = path.join(root, "local-jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const profiles = localProfiles();
  const resourceMonitor = createResourceMonitor();
  const settingsFile = path.join(root, "local-settings.json");
  let profile = "balanced";
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (profiles.some((item) => item.id === saved.profile)) profile = saved.profile;
  } catch { /* First run uses the balanced profile. */ }
  const settings = () => ({ profile, profiles: profiles.map(({ priority, ...item }) => item),
    cpuCount: os.availableParallelism ? os.availableParallelism() : os.cpus().length });
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
  app.use(express.json({ limit: "1mb" }));
  const binaries = async () => {
    try {
      await execFile(require("ffmpeg-static"), ["-version"], { windowsHide: true });
      await execFile(require("ffprobe-static").path, ["-version"], { windowsHide: true });
      return true;
    } catch { return false; }
  };
  app.get("/health", async (req, res) => res.json({ ffmpeg: await binaries(), version: 5, features: ["resource-profiles", "delete-failed", "optimize-existing", "optimize-season", "machine-resources"] }));
  app.get("/settings", (req, res) => res.json(settings()));
  app.post("/settings", (req, res) => {
    if (!profiles.some((item) => item.id === req.body?.profile)) return res.status(400).json({ error: "Perfil invalido." });
    try {
      fs.writeFileSync(settingsFile + ".tmp", JSON.stringify({ profile: req.body.profile }));
      fs.renameSync(settingsFile + ".tmp", settingsFile);
      profile = req.body.profile;
      res.json(settings());
    } catch { res.status(500).json({ error: "Nao foi possivel salvar o perfil." }); }
  });
  const snapshot = (job) => ({ id: job.id, title: job.title, status: job.status, message: job.message,
    percent: job.percent || 0, loaded: job.loaded || 0, total: job.total || 0,
    speedBytesPerSecond: job.speedBytesPerSecond || 0, lastTransferAt: job.lastTransferAt || null,
    resources: ["processing", "uploading", "downloading"].includes(job.status) ? {
      ...resourceMonitor.sample(),
      profile: { id: profile, label: profiles.find((item) => item.id === profile).label, threads: profiles.find((item) => item.id === profile).threads }
    } : null,
    processing: job.status === "processing" && job.current
      ? job.phase === "audio" ? engine.getPreparationSnapshot(job.current, job.currentTracks || [], true).find((track) => track.audioIndex === job.audioIndex)
        : job.phase === "video" ? engine.getHlsSnapshot(job.current) : null
      : null });
  app.get("/jobs", (req, res) => res.json([...jobs.values()].map(snapshot)));
  const start = (job) => queue(() => withMediaPolicy(() => profiles.find((item) => item.id === profile), async () => {
    try {
      if (job.remote && !job.files?.length) {
        job.status = "downloading"; job.message = "Baixando original da VPS para processar no PC.";
        job.loaded = 0; job.total = 0; job.percent = 0; job.speedBytesPerSecond = 0; persist(job);
        let sampleAt = Date.now(); let sampleLoaded = 0;
        const file = await downloadOriginal(origin, job, root, (loaded, total) => {
          const now = Date.now(); job.loaded = loaded; job.total = total;
          job.percent = total ? Math.floor(loaded / total * 100) : 0; job.lastTransferAt = now;
          if (now - sampleAt > 500) {
            job.speedBytesPerSecond = (loaded - sampleLoaded) / ((now - sampleAt) / 1000);
            sampleAt = now; sampleLoaded = loaded; persist(job);
          }
        });
        const item = engine.buildMovieItem(file, { title: job.title, processing: { enabled: true, qualities: job.remote.qualities } }, null);
        job.files = [file]; job.entries = [engine.findEntryById({ items: [item] }, item.id)]; persist(job);
      }
      job.status = "processing"; job.message = "Preparando video, audio e legendas no PC."; persist(job);
      job.analyses = [];
      for (const entry of job.entries) {
        job.current = entry.entryId;
        const analysis = await engine.analyzePlayback(entry);
        job.currentTracks = analysis.audioTracks;
        for (const track of analysis.audioTracks) {
          job.phase = "audio"; job.audioIndex = track.index; job.message = `Preparando audio ${track.displayLanguage || track.language} no PC.`;
          await engine.prepareVariant(entry, analysis, track.index, true);
        }
        job.phase = "subtitles"; job.message = "Preparando legendas no PC.";
        for (const track of analysis.subtitleTracks.filter((track) => track.kind === "subtitles")) {
          await engine.prepareSubtitle(entry, analysis, track.index);
        }
        job.phase = "video"; job.message = "Otimizando video no PC.";
        await engine.prepareHls(entry, analysis);
        if (engine.getHlsSnapshot(entry.entryId).status !== "ready") throw new Error("Escolha uma qualidade igual ou inferior ao video original.");
        const { sourcePath, ...metadata } = analysis;
        job.analyses.push(metadata);
      }
      job.status = "uploading"; job.message = "Enviando original e versoes prontas para a VPS.";
      job.loaded = 0; job.total = 0; job.percent = 0; job.speedBytesPerSecond = 0; job.lastTransferAt = Date.now(); persist(job);
      let last = 0;
      let sampleAt = Date.now();
      let sampleLoaded = 0;
      await sendPrepared(origin, job, root, (loaded, total) => {
        job.loaded = loaded; job.total = total; job.percent = Math.floor(loaded / total * 100);
        const now = Date.now();
        job.lastTransferAt = now;
        if (now - sampleAt >= 500) {
          job.speedBytesPerSecond = Math.max(0, (loaded - sampleLoaded) / ((now - sampleAt) / 1000));
          sampleAt = now; sampleLoaded = loaded;
        }
        if (Date.now() - last > 2000) { persist(job); last = Date.now(); }
      });
      job.status = "done"; job.percent = 100; job.message = "Disponivel na biblioteca."; persist(job);
      await fsp.rm(path.join(root, "uploads", job.id), { recursive: true, force: true });
      for (const entry of job.entries) await fsp.rm(path.join(root, "streams", entry.entryId), { recursive: true, force: true });
    } catch (error) { job.status = "error"; job.message = error.message; persist(job); }
  }));
  app.post("/jobs/:id/delete", async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Trabalho nao encontrado." });
    if (job.status !== "error") return res.status(409).json({ error: "Somente trabalhos com erro podem ser apagados." });
    job.status = "deleting";
    try {
      await cancelRemote(origin, job);
      if (!/^[a-f0-9]{32}$/.test(job.id)) throw new Error("Identificador invalido.");
      const targets = [path.resolve(root, "uploads", job.id)];
      for (const entry of job.entries || []) {
        if (!/^(movie|episode)_\d+_[a-z0-9]+$/.test(entry.entryId)) throw new Error("Midia invalida.");
        targets.push(path.resolve(root, "streams", entry.entryId));
      }
      // Validate all resolved targets before deleting any temporary media.
      const allowed = [path.resolve(root, "uploads") + path.sep, path.resolve(root, "streams") + path.sep];
      if (targets.some((target) => !allowed.some((prefix) => target.startsWith(prefix)))) throw new Error("Caminho invalido.");
      for (const target of targets) await fsp.rm(target, { recursive: true, force: true });
      await fsp.rm(path.join(jobsDir, job.id + ".json"), { force: true });
      await fsp.rm(path.join(jobsDir, job.id + ".json.tmp"), { force: true });
      jobs.delete(job.id);
      res.json({ deleted: true });
    } catch (error) {
      job.status = "error"; persist(job);
      res.status(500).json({ error: "Nao foi possivel apagar: " + error.message });
    }
  });
  app.post("/jobs/:id/retry", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== "error") return res.sendStatus(409);
    job.status = "queued"; persist(job); start(job); res.json(snapshot(job));
  });
  app.post("/jobs/from-server", async (req, res) => {
    try {
      if (!await binaries()) return res.status(503).json({ error: "Instale o FFmpeg pelo instalador do auxiliar." });
      const ticket = req.body?.ticket;
      if (!ticket || !/^[a-f0-9]{48}$/.test(ticket.id) || !/^[a-f0-9]{64}$/.test(ticket.token) || typeof ticket.filename !== "string" || typeof ticket.title !== "string") throw new Error("Autorizacao invalida.");
      const processing = parseProcessing({ enabled: true, qualities: ticket.qualities });
      if (req.body.profile && !profiles.some((item) => item.id === req.body.profile)) throw new Error("Perfil invalido.");
      const duplicate = [...jobs.values()].find((job) => job.ticket.id === ticket.id);
      if (duplicate) return res.json(snapshot(duplicate));
      if (req.body.profile) {
        fs.writeFileSync(settingsFile + ".tmp", JSON.stringify({ profile: req.body.profile }));
        fs.renameSync(settingsFile + ".tmp", settingsFile); profile = req.body.profile;
      }
      const job = { id: crypto.randomBytes(16).toString("hex"), title: ticket.title,
        ticket: { id: ticket.id, token: ticket.token }, remote: { filename: path.basename(ticket.filename), qualities: processing.qualities },
        entries: [], files: [], status: "queued", message: "Na fila para baixar o original." };
      jobs.set(job.id, job); persist(job); start(job); res.status(202).json(snapshot(job));
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post("/jobs/from-season", async (req, res) => {
    const created = [];
    try {
      if (!await binaries()) return res.status(503).json({ error: "Instale o FFmpeg pelo instalador do auxiliar." });
      const tickets = req.body?.tickets;
      if (!Array.isArray(tickets) || !tickets.length || tickets.length > 100) throw new Error("Temporada invalida.");
      if (req.body.profile && !profiles.some((item) => item.id === req.body.profile)) throw new Error("Perfil invalido.");
      for (const ticket of tickets) {
        if (!ticket || !/^[a-f0-9]{48}$/.test(ticket.id) || !/^[a-f0-9]{64}$/.test(ticket.token) ||
          typeof ticket.filename !== "string" || typeof ticket.title !== "string" || !(Number(ticket.episodeNumber) > 0)) throw new Error("Autorizacao de episodio invalida.");
        parseProcessing({ enabled: true, qualities: ticket.qualities });
      }
      if (new Set(tickets.map((ticket) => ticket.id)).size !== tickets.length) throw new Error("Episodio duplicado.");
      if (req.body.profile) {
        fs.writeFileSync(settingsFile + ".tmp", JSON.stringify({ profile: req.body.profile }));
        fs.renameSync(settingsFile + ".tmp", settingsFile); profile = req.body.profile;
      }
      const batch = [];
      for (const ticket of [...tickets].sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber))) {
        const previous = [...jobs.values()].find((job) => job.ticket.id === ticket.id);
        if (previous) { batch.push(previous); continue; }
        const job = { id: crypto.randomBytes(16).toString("hex"), title: ticket.title,
          ticket: { id: ticket.id, token: ticket.token }, remote: { filename: path.basename(ticket.filename), qualities: ticket.qualities, episodeNumber: ticket.episodeNumber },
          entries: [], files: [], status: "queued", message: `Episodio ${ticket.episodeNumber} na fila do PC.` };
        jobs.set(job.id, job); created.push(job); persist(job); batch.push(job);
      }
      // All jobs are persisted and queued synchronously in numeric episode order.
      created.forEach((job) => start(job));
      res.status(202).json({ jobs: batch.map(snapshot), message: "Temporada na fila do PC, na ordem dos episodios." });
    } catch (error) {
      for (const job of created) { job.status = "error"; job.message = error.message; persist(job); }
      res.status(400).json({ error: error.message });
    }
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
  server.once("error", (error) => {
    console.error(error.code === "EADDRINUSE"
      ? "Outro auxiliar ja esta aberto na porta 43123. Feche a janela antiga e abra novamente Iniciar-MegaRoom.cmd para carregar a versao atualizada."
      : error.message);
    process.exitCode = 1;
  });
  server.requestTimeout = 0;
})().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { createHelper, sendPrepared };
