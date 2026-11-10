const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const multer = require("multer");
const { parseProcessing } = require("./processing-options");

function artifactPath(field, count) {
  const match = /^asset-(\d+):(.+)$/.exec(field);
  if (!match || Number(match[1]) >= count) throw new Error("Invalid asset");
  const relative = match[2];
  if (!/^(?:hls\/(?:master\.m3u8|(?:\d+p|audio\/stream-\d+)\/(?:index\.m3u8|init\.mp4|segment_\d+\.m4s))|(?:original-)?audio-stream-\d+\.mp4|subtitles\/subtitle-\d+\.vtt)$/.test(relative)) {
    throw new Error("Invalid asset path");
  }
  return { index: Number(match[1]), relative };
}

async function verifyPlaylists(folder) {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { await verifyPlaylists(file); continue; }
    if (!entry.name.endsWith(".m3u8")) continue;
    const text = await fsp.readFile(file, "utf8");
    if (!text.startsWith("#EXTM3U")) throw new Error("Invalid playlist");
    const refs = [...text.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]);
    refs.push(...text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")));
    for (const ref of refs) {
      if (!/^[\w/-]+\.(?:m3u8|m4s|mp4)$/.test(ref) || ref.split("/").includes("..")) throw new Error("Unsafe playlist reference");
      const info = await fsp.stat(path.join(folder, ref));
      if (!info.isFile() || !info.size) throw new Error("Incomplete playlist");
    }
  }
}

function validateAnalysis(value) {
  if (!value || typeof value.videoCodec !== "string" ||
      !Number.isFinite(value.width) || !Number.isFinite(value.height) ||
      value.width < 1 || value.height < 1 || value.width > 16384 || value.height > 16384 ||
      !Array.isArray(value.audioTracks) || !Array.isArray(value.subtitleTracks) ||
      value.audioTracks.length > 32 || value.subtitleTracks.length > 128 ||
      !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0) throw new Error("Invalid analysis");
  for (const tracks of [value.audioTracks, value.subtitleTracks]) {
    tracks.forEach((track, i) => {
      if (track.index !== i || !Number.isInteger(track.ffmpegStreamIndex) || track.ffmpegStreamIndex < 0) throw new Error("Invalid tracks");
    });
  }
  const { sourcePath, ...safe } = value;
  return safe;
}

function createLocalImport({ root, buildMovieItem, buildSeriesItem, updateLibrary, readLibrary }) {
  const ticketDir = path.join(root, "data", "local-tickets");
  fs.mkdirSync(ticketDir, { recursive: true });
  const active = new Set();
  const ticket = async (req, res) => {
    try {
      const body = req.body;
      if (!["movie", "series"].includes(body.kind) || !Number.isInteger(body.count) || body.count < 1 || body.count > 100 || (body.kind === "movie" && body.count !== 1)) throw new Error("Invalid media count");
      const processing = parseProcessing({ enabled: true, qualities: body.qualities });
      const id = crypto.randomBytes(24).toString("hex");
      const token = crypto.randomBytes(32).toString("hex");
      for (const file of await fsp.readdir(ticketDir)) {
        if (!/^[a-f0-9]{48}\.json$/.test(file)) continue;
        const old = JSON.parse(await fsp.readFile(path.join(ticketDir, file), "utf8"));
        if (old.expires < Date.now()) await fsp.unlink(path.join(ticketDir, file));
      }
      await fsp.writeFile(path.join(ticketDir, id + ".json"), JSON.stringify({
        token, expires: Date.now() + 7 * 86400000, kind: body.kind, count: body.count,
        fields: { title: String(body.title || "").slice(0, 300), genre: String(body.genre || "").slice(0, 300),
          synopsis: String(body.synopsis || "").slice(0, 10000), year: String(body.year || "").slice(0, 20),
          seasonNumber: Number(body.seasonNumber) || 1, processing }
      }), { mode: 0o600 });
      res.json({ id, token });
    } catch { res.status(400).json({ error: "Dados invalidos para envio local." }); }
  };
  const transfer = require("express").Router();
  transfer.post("/:id", async (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9]{48}$/.test(id)) return res.sendStatus(404);
    let saved;
    try { saved = JSON.parse(await fsp.readFile(path.join(ticketDir, id + ".json"), "utf8")); }
    catch { return res.sendStatus(404); }
    if (saved.token !== req.get("x-import-token") || saved.expires < Date.now()) return res.sendStatus(403);
    if (active.has(id)) return res.sendStatus(409);
    if (saved.result) return res.json(saved.result);
    active.add(id);
    try {
      const published = (await readLibrary()).items.find((item) => item.localImportId === id);
      if (published) { active.delete(id); return res.json({ item: published }); }
    } catch {
      active.delete(id); return res.status(500).json({ error: "Nao foi possivel ler o catalogo." });
    }
    const stage = path.join(root, "uploads", "local-" + id);
    const moved = [];
    let committed = false;
    try {
      await fsp.rm(stage, { recursive: true, force: true });
      const seen = new Set();
      const storage = multer.diskStorage({
        destination(request, file, cb) {
          try {
            if (seen.has(file.fieldname)) throw new Error("Duplicate asset");
            seen.add(file.fieldname);
            let target;
            if (file.fieldname === "cover" || /^source-\d+$/.test(file.fieldname)) target = path.join(stage, "originals");
            else {
              const asset = artifactPath(file.fieldname, saved.count);
              target = path.dirname(path.join(stage, "prepared", String(asset.index), asset.relative));
            }
            fs.mkdirSync(target, { recursive: true }); cb(null, target);
          } catch (error) { cb(error); }
        },
        filename(request, file, cb) {
          if (file.fieldname.startsWith("asset-")) return cb(null, path.basename(artifactPath(file.fieldname, saved.count).relative));
          cb(null, file.fieldname + "-" + path.basename(file.originalname).replace(/[^\w. -]/g, "_"));
        }
      });
      await new Promise((resolve, reject) => multer({ storage, limits: { fields: 1, fieldSize: 2 * 1024 * 1024, files: 200000 } }).any()(req, res, (error) => error ? reject(error) : resolve()));
      const metadata = JSON.parse(req.body.manifest);
      if (!Array.isArray(metadata) || metadata.length !== saved.count) throw new Error("Invalid manifest");
      const files = Array.from({ length: saved.count }, (_, i) => req.files.find((file) => file.fieldname === `source-${i}`));
      if (files.some((file) => !file || !file.size)) throw new Error("Missing original");
      const cover = req.files.find((file) => file.fieldname === "cover");
      if (cover && !/^image\//.test(cover.mimetype)) throw new Error("Invalid cover");
      const item = saved.kind === "movie" ? buildMovieItem(files[0], saved.fields, cover) : buildSeriesItem(files, saved.fields, cover);
      item.folder = path.basename(stage);
      item.localImportId = id;
      const entries = item.type === "movie" ? [item] : item.episodes;
      for (let i = 0; i < entries.length; i++) {
        const analysis = validateAnalysis(metadata[i]);
        const prepared = path.join(stage, "prepared", String(i));
        await verifyPlaylists(prepared);
        if (!fs.existsSync(path.join(prepared, "hls", "master.m3u8"))) throw new Error("Missing optimized video");
        // Ensure the default MP4 and text subtitles never require server conversion.
        for (const track of analysis.audioTracks) {
          if (!fs.existsSync(path.join(prepared, `original-audio-stream-${track.ffmpegStreamIndex}.mp4`))) throw new Error("Missing original audio");
        }
        for (const track of analysis.subtitleTracks.filter((track) => track.kind === "subtitles")) {
          if (!fs.existsSync(path.join(prepared, "subtitles", `subtitle-${track.index}.vtt`))) throw new Error("Missing subtitle");
        }
        entries[i].localAnalysis = analysis;
        const dest = path.join(root, "streams", entries[i].id);
        await fsp.rename(prepared, dest); moved.push(dest);
      }
      await updateLibrary((library) => { library.items.unshift(item); });
      committed = true;
      saved.result = { item };
      await fsp.writeFile(path.join(ticketDir, id + ".json"), JSON.stringify(saved), { mode: 0o600 });
      await fsp.rm(path.join(stage, "prepared"), { recursive: true, force: true });
      res.status(201).json(saved.result);
    } catch (error) {
      if (!committed) {
        for (const dest of moved) await fsp.rm(dest, { recursive: true, force: true });
        await fsp.rm(stage, { recursive: true, force: true });
      }
      console.error("[LOCAL IMPORT]", error.message);
      res.status(400).json({ error: "Envio local incompleto: " + error.message });
    } finally { active.delete(id); }
  });
  return { ticket, transfer };
}

module.exports = { createLocalImport, artifactPath, verifyPlaylists };
