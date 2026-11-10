const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const { parseProcessing } = require("./processing-options");
const { orderedEpisodes } = require("./episode-order");
const { artifactPath, verifyPlaylists, validateAnalysis } = require("./local-import");

function mergeMasters(previous, incoming, entryId, batch) {
  const variants = new Map();
  let audio = [];
  for (const [text, prefix] of [[previous, `/streams/${entryId}/hls/`], [incoming, `/streams/${entryId}/${batch}/hls/`]]) {
    const lines = text.split(/\r?\n/);
    const resolve = (uri) => {
      if (uri.startsWith(`/streams/${entryId}/`)) return uri;
      if (!/^[\w/-]+\.(?:m3u8|mp4|m4s)$/.test(uri) || uri.split("/").includes("..")) throw new Error("Invalid playlist reference");
      return prefix + uri;
    };
    const tracks = lines.filter((line) => line.startsWith("#EXT-X-MEDIA:")).map((line) => line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${resolve(uri)}"`));
    if (tracks.length) audio = tracks;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const uri = lines[i + 1];
      const height = Number(/(?:^|\/)(\d+)p\/index\.m3u8$/.exec(uri)?.[1]);
      if (!height) throw new Error("Invalid quality");
      variants.set(height, [lines[i], resolve(uri)]);
    }
  }
  return ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS", ...audio,
    ...[...variants].sort(([a], [b]) => a - b).flatMap(([, lines]) => lines), ""].join("\n");
}

function createExistingLocal({ root, readLibrary, updateLibrary, findEntryById, analyzePlayback, getHlsRenditions, readHlsQualities, busy }) {
  const ticketsDir = path.join(root, "data", "existing-tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  const reservations = new Map();
  const transfers = new Set();
  const transferringEntries = new Set();
  for (const file of fs.readdirSync(ticketsDir)) {
    if (!/^[a-f0-9]{48}\.json$/.test(file)) continue;
    const saved = JSON.parse(fs.readFileSync(path.join(ticketsDir, file), "utf8"));
    if (!saved.result && saved.expires > Date.now()) reservations.set(saved.entryId, { id: file.slice(0, -5), expires: saved.expires });
  }
  const isReserved = (entryId) => (reservations.get(entryId)?.expires || 0) > Date.now();
  const save = (id, data) => fsp.writeFile(path.join(ticketsDir, id + ".json"), JSON.stringify(data), { mode: 0o600 });
  const issueTicket = async (entryId, qualities, alreadyReserved = false) => {
    if (!alreadyReserved && (busy(entryId) || isReserved(entryId))) return { status: 409, payload: { error: "Esta midia ja tem uma otimizacao pendente." } };
    reservations.set(entryId, { expires: Date.now() + 60000 });
    let reserved = false;
    try {
      const processing = parseProcessing({ enabled: true, qualities });
      const entry = findEntryById(await readLibrary(), entryId);
      if (!entry) return { status: 404, payload: { error: "Midia nao encontrada." } };
      const analysis = await analyzePlayback(entry);
      const selected = getHlsRenditions(analysis, processing);
      if (!selected.length) return { status: 422, payload: { error: "Escolha qualidades iguais ou inferiores ao original." } };
      const master = path.join(root, "streams", entryId, "hls", "master.m3u8");
      const existing = readHlsQualities(master);
      if (selected.every((quality) => existing.includes(quality.height))) return { status: 200, payload: { ready: true, message: "As qualidades selecionadas ja estao prontas." } };
      const id = crypto.randomBytes(24).toString("hex");
      const token = crypto.randomBytes(32).toString("hex");
      const saved = { entryId, sourceSrc: entry.sourceSrc, token, expires: Date.now() + 7 * 86400000, processing };
      await save(id, saved);
      reservations.set(entryId, { id, expires: saved.expires }); reserved = true;
      return { status: 200, payload: { id, token, qualities: processing.qualities, title: entry.title,
        filename: path.basename(entry.sourceSrc), entryId, episodeNumber: entry.episode?.episodeNumber } };
    } catch (error) { return { status: 400, payload: { error: "Nao foi possivel preparar a otimizacao local: " + error.message } }; }
    finally { if (!reserved) reservations.delete(entryId); }
  };
  const ticket = async (req, res) => {
    const result = await issueTicket(req.params.entryId, req.body?.qualities);
    res.status(result.status).json(result.payload);
  };
  const seasonTickets = async (req, res) => {
    const issued = [];
    let episodes = [];
    try {
      parseProcessing({ enabled: true, qualities: req.body?.qualities });
      const season = (await readLibrary()).items.find((item) => item.id === req.params.mediaId && item.type === "series");
      if (!season) return res.status(404).json({ error: "Temporada nao encontrada." });
      const ordered = orderedEpisodes(season);
      if (ordered.some((episode) => busy(episode.id) || isReserved(episode.id))) return res.status(409).json({ error: "Um episodio da temporada ja tem otimizacao pendente." });
      episodes = ordered;
      episodes.forEach((episode) => reservations.set(episode.id, { expires: Date.now() + 60000 }));
      const skipped = [];
      for (const episode of episodes) {
        const result = await issueTicket(episode.id, req.body.qualities, true);
        if (result.payload.ready || result.status === 422) { skipped.push(episode.id); continue; }
        if (result.status !== 200) throw new Error(result.payload.error);
        issued.push(result.payload);
      }
      res.json({ tickets: issued, skipped, ready: issued.length === 0,
        message: issued.length ? `${issued.length} episodio(s) autorizado(s), na ordem numerica.` : "Nenhum episodio precisa das qualidades selecionadas." });
    } catch (error) {
      for (const item of issued) {
        const file = JSON.parse(await fsp.readFile(path.join(ticketsDir, item.id + ".json"), "utf8"));
        file.expires = 0; await save(item.id, file);
      }
      episodes.forEach((episode) => reservations.delete(episode.id));
      res.status(400).json({ error: "Nao foi possivel preparar a temporada: " + error.message });
    }
  };
  const transfer = express.Router();
  transfer.use("/:id", async (req, res, next) => {
    if (!/^[a-f0-9]{48}$/.test(req.params.id)) return res.sendStatus(404);
    try {
      const saved = JSON.parse(await fsp.readFile(path.join(ticketsDir, req.params.id + ".json"), "utf8"));
      if (saved.token !== req.get("x-import-token") || saved.expires < Date.now()) return res.sendStatus(403);
      req.localTicket = saved; req.localTicketId = req.params.id; next();
    } catch { res.sendStatus(404); }
  });
  transfer.get("/:id/source", async (req, res) => {
    const saved = req.localTicket;
    const entry = findEntryById(await readLibrary(), saved.entryId);
    if (!entry || entry.sourceSrc !== saved.sourceSrc) return res.sendStatus(404);
    const source = path.resolve(root, ...entry.sourceSrc.replace(/^\//, "").split("/"));
    if (!source.startsWith(path.resolve(root, "uploads") + path.sep)) return res.sendStatus(403);
    res.sendFile(source);
  });
  transfer.post("/:id/cancel", async (req, res) => {
    if (transfers.has(req.localTicketId)) return res.sendStatus(409);
    req.localTicket.expires = 0;
    await save(req.localTicketId, req.localTicket);
    if (reservations.get(req.localTicket.entryId)?.id === req.localTicketId) reservations.delete(req.localTicket.entryId);
    res.json({ cancelled: true });
  });
  transfer.post("/:id", async (req, res) => {
    const saved = req.localTicket;
    const id = req.localTicketId;
    if (saved.result) return res.json(saved.result);
    if (transfers.has(id)) return res.sendStatus(409);
    transfers.add(id);
    transferringEntries.add(saved.entryId);
    const stage = path.join(root, "streams", saved.entryId, ".local-" + id);
    const batch = "local-" + id + "-" + crypto.randomBytes(6).toString("hex");
    const destination = path.join(root, "streams", saved.entryId, batch);
    let published = false;
    try {
      const entry = findEntryById(await readLibrary(), saved.entryId);
      if (!entry || entry.sourceSrc !== saved.sourceSrc) return res.status(404).json({ error: "A midia original foi removida ou alterada." });
      if ((entry.episode || entry.parent).localOptimizationId === id) {
        saved.result = { ready: true }; await save(id, saved); reservations.delete(saved.entryId);
        return res.json(saved.result);
      }
      await fsp.rm(stage, { recursive: true, force: true });
      const seen = new Set();
      const storage = multer.diskStorage({
        destination(request, file, cb) {
          try {
            const asset = artifactPath(file.fieldname, 1);
            if (seen.has(asset.relative)) throw new Error("Duplicate asset");
            seen.add(asset.relative);
            const folder = path.dirname(path.join(stage, asset.relative));
            fs.mkdirSync(folder, { recursive: true }); cb(null, folder);
          } catch (error) { cb(error); }
        },
        filename(request, file, cb) { cb(null, path.basename(artifactPath(file.fieldname, 1).relative)); }
      });
      await new Promise((resolve, reject) => multer({ storage, limits: { fields: 1, fieldSize: 2 * 1024 * 1024, files: 50000 } }).any()(req, res, (error) => error ? reject(error) : resolve()));
      const metadata = JSON.parse(req.body.manifest);
      if (!Array.isArray(metadata) || metadata.length !== 1) throw new Error("Invalid manifest");
      const analysis = validateAnalysis(metadata[0]);
      await verifyPlaylists(stage);
      const incoming = await fsp.readFile(path.join(stage, "hls", "master.m3u8"), "utf8");
      const expected = getHlsRenditions(analysis, saved.processing);
      if (!expected.length || expected.some((quality) => !fs.existsSync(path.join(stage, "hls", quality.name, "index.m3u8")))) throw new Error("Missing selected quality");
      const master = path.join(root, "streams", saved.entryId, "hls", "master.m3u8");
      const previous = fs.existsSync(master) ? await fsp.readFile(master, "utf8") : "";
      const merged = mergeMasters(previous, incoming, saved.entryId, batch);
      await fsp.rename(stage, destination);
      // Add original-audio and subtitle copies only when missing; existing players keep their files.
      for (const file of fs.readdirSync(destination).filter((name) => /^original-audio-stream-\d+\.mp4$/.test(name))) {
        const target = path.join(root, "streams", saved.entryId, file);
        if (!fs.existsSync(target)) await fsp.link(path.join(destination, file), target);
      }
      const subtitles = path.join(destination, "subtitles");
      if (fs.existsSync(subtitles)) {
        const target = path.join(root, "streams", saved.entryId, "subtitles"); fs.mkdirSync(target, { recursive: true });
        for (const file of fs.readdirSync(subtitles)) if (!fs.existsSync(path.join(target, file))) await fsp.copyFile(path.join(subtitles, file), path.join(target, file));
      }
      fs.mkdirSync(path.dirname(master), { recursive: true });
      await fsp.writeFile(master + ".tmp", merged); await fsp.rename(master + ".tmp", master); published = true;
      const qualities = [...new Set([...saved.processing.qualities, ...readHlsQualities(master).filter((height) => [480, 720, 1080].includes(height))])];
      await updateLibrary((library) => {
        const current = findEntryById(library, saved.entryId);
        if (!current || current.sourceSrc !== saved.sourceSrc) throw new Error("Original changed");
        Object.assign(current.episode || current.parent, { processing: { enabled: true, qualities }, localAnalysis: analysis, localOptimizationId: id });
      });
      saved.result = { ready: true, message: "Qualidades locais disponiveis na mesma midia." };
      await save(id, saved); reservations.delete(saved.entryId);
      res.json(saved.result);
    } catch (error) {
      await fsp.rm(stage, { recursive: true, force: true });
      if (!published) await fsp.rm(destination, { recursive: true, force: true });
      res.status(400).json({ error: "Otimizacao local incompleta: " + error.message });
    } finally { transfers.delete(id); transferringEntries.delete(saved.entryId); }
  });
  return { ticket, seasonTickets, transfer, isReserved,
    isTransferring: (id) => transferringEntries.has(id),
    forgetEntries: (ids) => ids.forEach((id) => reservations.delete(id)) };
}
module.exports = { createExistingLocal, mergeMasters };
