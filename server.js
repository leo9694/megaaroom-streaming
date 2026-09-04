const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");
const { execFile, spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const hlsJsPath = require.resolve("hls.js/dist/hls.min.js");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const STREAMS_DIR = path.join(ROOT, "streams");
const LIBRARY_FILE = path.join(DATA_DIR, "library.json");
const APP_USERNAME = process.env.APP_USERNAME || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const accessProtectionEnabled = Boolean(APP_USERNAME && APP_PASSWORD);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(STREAMS_DIR, { recursive: true });

if (!fs.existsSync(LIBRARY_FILE)) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify({ items: [] }, null, 2));
}

let libraryWriteQueue = Promise.resolve();
const analysisCache = new Map();
const prepareJobs = new Map();
const prepareStatus = new Map();
const hlsJobs = new Map();
const hlsStatus = new Map();
let mediaProcessingQueue = Promise.resolve();
const queuedPreparationJobs = new Map();
const subtitleJobs = new Map();
const subtitleStatus = new Map();
const uploadProgress = new Map();

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildFolderName() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeFilename(name, fallback = "file") {
  return name.replace(/[^\w.\- ]+/g, "").trim() || fallback;
}

function ensureRequestFolder(req) {
  if (!req.uploadFolderName) {
    req.uploadFolderName = buildFolderName();
  }
  return req.uploadFolderName;
}

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folderName = ensureRequestFolder(req);
    const folder = path.join(UPLOADS_DIR, folderName);
    fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const prefix = file.fieldname === "cover" ? "cover" : Date.now().toString();
    cb(null, `${prefix}-${Math.random().toString(36).slice(2, 7)}-${sanitizeFilename(file.originalname)}`);
  }
});

const upload = multer({ storage: uploadStorage });

const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    readLibrary()
      .then((library) => {
        const item = library.items.find((entry) => entry.id === req.params.id);
        if (!item) {
          cb(new Error("MEDIA_NOT_FOUND"));
          return;
        }
        const folder = path.join(UPLOADS_DIR, item.folder);
        fs.mkdirSync(folder, { recursive: true });
        req.coverFolder = folder;
        cb(null, folder);
      })
      .catch((error) => cb(error));
  },
  filename: (req, file, cb) => {
    cb(null, `cover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${sanitizeFilename(file.originalname, "cover")}`);
  }
});

const coverUpload = multer({ storage: coverStorage });

app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  if (!accessProtectionEnabled) {
    next();
    return;
  }

  const authorization = req.get("authorization") || "";
  const encoded = authorization.startsWith("Basic ") ? authorization.slice(6) : "";
  let credentials = "";
  try {
    credentials = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    credentials = "";
  }
  const expected = `${APP_USERNAME}:${APP_PASSWORD}`;
  const providedBuffer = Buffer.from(credentials);
  const expectedBuffer = Buffer.from(expected);
  const authorized = providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  if (authorized) {
    next();
    return;
  }

  res.set("WWW-Authenticate", 'Basic realm="MegaRoom", charset="UTF-8"');
  res.status(401).send("Autenticacao necessaria.");
});
app.use((req, res, next) => {
  if (!req.path.startsWith("/uploads/") && !req.path.startsWith("/streams/")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});
app.get("/vendor/hls.min.js", (req, res) => {
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(hlsJsPath);
});
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/streams", express.static(STREAMS_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
    } else if (filePath.endsWith(".m4s") || filePath.endsWith(".mp4")) {
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    }
  }
}));
app.use(express.static(path.join(ROOT, "public")));

async function readLibrary() {
  const raw = await fsp.readFile(LIBRARY_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeLibrary(data) {
  await fsp.writeFile(LIBRARY_FILE, JSON.stringify(data, null, 2));
}

function updateLibrary(mutator) {
  libraryWriteQueue = libraryWriteQueue.then(async () => {
    const library = await readLibrary();
    const result = await mutator(library);
    await writeLibrary(library);
    return result;
  });
  return libraryWriteQueue;
}

function markUploadProgress(uploadId, patch) {
  if (!uploadId) {
    return null;
  }

  const current = uploadProgress.get(uploadId) || {
    uploadId,
    status: "receiving",
    receivedBytes: 0,
    totalBytes: 0,
    percent: 0,
    updatedAt: Date.now()
  };

  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  };

  if (typeof next.totalBytes === "number" && next.totalBytes > 0) {
    next.percent = Math.max(0, Math.min(100, Math.round((next.receivedBytes / next.totalBytes) * 100)));
  }

  uploadProgress.set(uploadId, next);
  return next;
}

function createUploadTracker(req, res, next) {
  const uploadId = String(req.query.uploadId || "").trim();
  if (!uploadId) {
    next();
    return;
  }

  const totalBytes = Number(req.headers["content-length"] || 0);
  req.uploadId = uploadId;
  markUploadProgress(uploadId, {
    status: "receiving",
    receivedBytes: 0,
    totalBytes
  });

  req.on("data", (chunk) => {
    const current = uploadProgress.get(uploadId);
    markUploadProgress(uploadId, {
      status: "receiving",
      receivedBytes: (current?.receivedBytes || 0) + chunk.length
    });
  });

  req.on("aborted", () => {
    markUploadProgress(uploadId, { status: "aborted" });
  });

  res.on("finish", () => {
    const current = uploadProgress.get(uploadId);
    if (!current) {
      return;
    }

    markUploadProgress(uploadId, {
      status: res.statusCode >= 400 ? "error" : "completed",
      receivedBytes: current.totalBytes || current.receivedBytes
    });

    setTimeout(() => {
      uploadProgress.delete(uploadId);
    }, 30000);
  });

  next();
}

async function removeDirectoryIfExists(targetPath, attempts = 5) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return true;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fsp.rm(targetPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY") {
        throw error;
      }

      if (attempt === attempts) {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 700));
    }
  }

  return false;
}

function fileToSrc(file) {
  return `/uploads/${path.basename(path.dirname(file.path))}/${path.basename(file.path)}`;
}

function coverToData(file) {
  if (!file) {
    return null;
  }
  return {
    originalName: file.originalname,
    src: fileToSrc(file)
  };
}

function titleFromFilename(name, fallback) {
  const cleaned = path.parse(name || "").name.replace(/[._-]+/g, " ").trim();
  return cleaned || fallback;
}

function buildMovieItem(file, body, coverFile) {
  const providedTitle = (body.title || "").trim();
  return {
    id: createId("movie"),
    type: "movie",
    title: providedTitle || titleFromFilename(file.originalname, "Filme sem titulo"),
    genre: (body.genre || "Nao informado").trim(),
    year: (body.year || "").trim(),
    synopsis: (body.synopsis || "Sem sinopse cadastrada.").trim(),
    createdAt: new Date().toISOString(),
    folder: path.basename(path.dirname(file.path)),
    cover: coverToData(coverFile),
    video: {
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      src: fileToSrc(file)
    }
  };
}

function buildSeriesItem(files, body, coverFile) {
  return {
    id: createId("series"),
    type: "series",
    title: body.title.trim(),
    genre: (body.genre || "Nao informado").trim(),
    year: (body.year || "").trim(),
    synopsis: (body.synopsis || "Sem sinopse cadastrada.").trim(),
    createdAt: new Date().toISOString(),
    seasonNumber: Number(body.seasonNumber) || 1,
    folder: path.basename(path.dirname(files[0].path)),
    cover: coverToData(coverFile),
    episodes: files.map((file, index) => ({
      id: createId("episode"),
      episodeNumber: index + 1,
      title: titleFromFilename(file.originalname, `Episodio ${index + 1}`),
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      src: fileToSrc(file)
    }))
  };
}

function srcToAbsolutePath(src) {
  const relative = src.replace(/^\//, "").split("/").filter(Boolean);
  return path.join(ROOT, ...relative);
}

function normalizeLanguage(code) {
  const value = String(code || "").toLowerCase();
  if (["por", "pt", "pt-br", "pob", "pb"].includes(value)) {
    return "Português";
  }
  if (["eng", "en", "en-us", "en-gb"].includes(value)) {
    return "Inglês";
  }
  if (["spa", "es"].includes(value)) {
    return "Espanhol";
  }
  if (!value || value === "und") {
    return "Idioma não identificado";
  }
  return value;
}

function normalizeSubtitleKind(codec) {
  const value = String(codec || "").toLowerCase();
  if (["subrip", "ass", "ssa", "webvtt", "mov_text"].includes(value)) {
    return "subtitles";
  }
  return "metadata";
}

function getPreferredAudioOrder(audioTracks) {
  const scored = audioTracks.map((track, index) => {
    const language = String(track.language || "").toLowerCase();
    let score = 100 + index;
    if (language.includes("portugu")) {
      score = 0;
    } else if (language.includes("ingl")) {
      score = 10;
    } else if (track.isOriginal) {
      score = 20;
    }
    return { track, score };
  });

  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.track);
}

function isSupportedAudioTrack(track) {
  const language = String(track.language || "").toLowerCase();
  return track.isOriginal || language.includes("portugu") || language.includes("ingl");
}

function findEntryById(library, entryId) {
  for (const item of library.items) {
    if (item.id === entryId) {
      return {
        entryId,
        kind: "movie",
        mediaId: item.id,
        parent: item,
        sourceSrc: item.video.src,
        title: item.title
      };
    }

    const episode = (item.episodes || []).find((entry) => entry.id === entryId);
    if (episode) {
      return {
        entryId,
        kind: "episode",
        mediaId: item.id,
        parent: item,
        episode,
        sourceSrc: episode.src,
        title: `${item.title} - ${episode.title}`
      };
    }
  }
  return null;
}

function ffprobeJson(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", filePath],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function parseTimestampToSeconds(value) {
  if (!value || typeof value !== "string") {
    return 0;
  }
  const [h, m, s] = value.split(":");
  return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

async function analyzePlayback(entry) {
  const sourcePath = srcToAbsolutePath(entry.sourceSrc);
  const cacheKey = `${entry.entryId}:${sourcePath}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const probe = await ffprobeJson(sourcePath);
  const detectedAudioTracks = (probe.streams || [])
    .filter((stream) => stream.codec_type === "audio")
    .map((stream, index) => ({
      index,
      ffmpegStreamIndex: stream.index,
      codec: stream.codec_name || "unknown",
      language: normalizeLanguage(stream.tags?.language),
      title: stream.tags?.title || `Faixa ${index + 1}`,
      channels: stream.channels || null,
      isOriginal: index === 0
    }));
  const audioTracks = getPreferredAudioOrder(detectedAudioTracks.filter(isSupportedAudioTrack))
    .map((track, index) => ({
      ...track,
      index,
      displayLanguage: track.isOriginal ? `Original (${track.language})` : track.language
    }));
  const subtitleTracks = (probe.streams || [])
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream, index) => ({
      index,
      ffmpegStreamIndex: stream.index,
      codec: stream.codec_name || "unknown",
      language: normalizeLanguage(stream.tags?.language),
      title: stream.tags?.title || `Legenda ${index + 1}`,
      kind: normalizeSubtitleKind(stream.codec_name)
    }));

  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const analysis = {
    sourcePath,
    sourceExt: path.extname(sourcePath).toLowerCase(),
    videoCodec: videoStream?.codec_name || "",
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    durationSeconds: Number(probe.format?.duration || 0),
    audioTracks,
    subtitleTracks,
    requiresPreparedStream:
      path.extname(sourcePath).toLowerCase() !== ".mp4" ||
      detectedAudioTracks.length > 1 ||
      (videoStream?.codec_name || "") !== "h264"
  };

  analysisCache.set(cacheKey, analysis);
  return analysis;
}

function getAudioTrackKey(track) {
  return `stream-${track.ffmpegStreamIndex}`;
}

function getPreparedVariantPath(entryId, track) {
  const trackKey = getAudioTrackKey(track);
  const folder = path.join(STREAMS_DIR, entryId);
  const filePath = path.join(folder, `audio-${trackKey}.mp4`);
  return {
    folder,
    filePath,
    publicSrc: `/streams/${entryId}/audio-${trackKey}.mp4`
  };
}

const HLS_RENDITIONS = [
  { name: "1080p", width: 1920, height: 1080, maxRate: "4600k", bufferSize: "6500k", bandwidth: 4800000, level: "4.0", codec: "avc1.640028" },
  { name: "720p", width: 1280, height: 720, maxRate: "2500k", bufferSize: "3500k", bandwidth: 2700000, level: "3.1", codec: "avc1.64001f" },
  { name: "480p", width: 854, height: 480, maxRate: "1250k", bufferSize: "1800k", bandwidth: 1400000, level: "3.0", codec: "avc1.64001e" }
];

function getHlsPaths(entryId, temporary = false) {
  const suffix = temporary ? ".hls-tmp" : "hls";
  const folder = path.join(STREAMS_DIR, entryId, suffix);
  return {
    folder,
    masterPath: path.join(folder, "master.m3u8"),
    publicSrc: `/streams/${entryId}/hls/master.m3u8`
  };
}

function getHlsRenditions(analysis) {
  const sourceWidth = analysis.width || 854;
  const sourceHeight = analysis.height || 480;
  const eligible = HLS_RENDITIONS.filter(
    (rendition) => rendition.width <= sourceWidth || rendition.height <= sourceHeight
  );
  if (eligible.length) {
    return eligible.sort((a, b) => a.height - b.height);
  }

  const height = Math.max(2, sourceHeight - (sourceHeight % 2));
  return [{
    name: `${height}p`,
    width: Math.max(2, (analysis.width || 854) - ((analysis.width || 854) % 2)),
    height,
    maxRate: "963k",
    bufferSize: "1350k",
    bandwidth: 1150000,
    level: "3.0",
    codec: "avc1.64001e"
  }];
}

function getHlsResolution(analysis, rendition) {
  const sourceWidth = analysis.width || rendition.width;
  const sourceHeight = analysis.height || rendition.height;
  const scale = Math.min(1, rendition.width / sourceWidth, rendition.height / sourceHeight);
  return {
    width: Math.max(2, Math.floor((sourceWidth * scale) / 2) * 2),
    height: Math.max(2, Math.floor((sourceHeight * scale) / 2) * 2)
  };
}

function hlsLanguageCode(language) {
  const value = String(language || "").toLowerCase();
  if (value.includes("portugu")) return "pt-BR";
  if (value.includes("ingl")) return "en";
  if (value === "jpn" || value.includes("japon")) return "ja";
  return value || "und";
}

function escapeHlsAttribute(value) {
  return String(value || "").replace(/["\r\n]/g, "");
}

function summarizeProcessError(error) {
  const lines = String(error?.message || error || "Erro desconhecido")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-5).join(" | ");
}

function buildHlsMasterPlaylist(analysis, renditions) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  analysis.audioTracks.forEach((track, index) => {
    const name = escapeHlsAttribute(track.displayLanguage || track.language || `Audio ${index + 1}`);
    const language = escapeHlsAttribute(hlsLanguageCode(track.language));
    const defaultFlags = index === 0 ? "YES" : "NO";
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",LANGUAGE="${language}",DEFAULT=${defaultFlags},AUTOSELECT=YES,URI="audio/${getAudioTrackKey(track)}/index.m3u8"`
    );
  });

  // Menor qualidade primeiro: o player inicia rapido e sobe conforme a banda medida.
  for (const rendition of [...renditions].sort((a, b) => a.height - b.height)) {
    const resolution = getHlsResolution(analysis, rendition);
    const audioGroup = analysis.audioTracks.length ? ',AUDIO="audio"' : "";
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AVERAGE-BANDWIDTH=${Math.round(rendition.bandwidth * 0.88)},RESOLUTION=${resolution.width}x${resolution.height},CODECS="${rendition.codec},mp4a.40.2"${audioGroup}`
    );
    lines.push(`${rendition.name}/index.m3u8`);
  }

  return `${lines.join("\n")}\n`;
}

async function ensureHlsDiskSpace(sourcePath, analysis, renditions) {
  if (typeof fsp.statfs !== "function") {
    return;
  }
  const [disk, source] = await Promise.all([fsp.statfs(STREAMS_DIR), fsp.stat(sourcePath)]);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const totalBitsPerSecond = renditions.reduce((sum, rendition) => sum + rendition.bandwidth, 0)
    + analysis.audioTracks.length * 160000;
  const bitrateEstimate = analysis.durationSeconds > 0
    ? (totalBitsPerSecond * analysis.durationSeconds) / 8
    : source.size * 1.5;
  const requiredBytes = Math.max(2 * 1024 ** 3, Math.round(bitrateEstimate * 1.25));
  if (freeBytes < requiredBytes) {
    throw new Error(`Espaco insuficiente para HLS. Livre: ${Math.round(freeBytes / 1024 ** 3)} GB; minimo estimado: ${Math.round(requiredBytes / 1024 ** 3)} GB.`);
  }
}

function readHlsQualities(masterPath) {
  try {
    const playlist = fs.readFileSync(masterPath, "utf8");
    return [...playlist.matchAll(/#EXT-X-STREAM-INF:[^\n]*\n(?:\.\/)?(\d+)p\/index\.m3u8/g)]
      .map((match) => Number(match[1]))
      .filter((height, index, values) => Number.isFinite(height) && values.indexOf(height) === index)
      .sort((a, b) => b - a);
  } catch {
    return [];
  }
}

function getHlsSnapshot(entryId) {
  const hls = getHlsPaths(entryId);
  if (fs.existsSync(hls.masterPath)) {
    const status = hlsStatus.get(entryId);
    const diskQualities = readHlsQualities(hls.masterPath);
    return {
      status: "ready",
      percent: 100,
      message: "Streaming adaptativo pronto.",
      source: hls.publicSrc,
      qualities: diskQualities.length ? diskQualities : status?.qualities || []
    };
  }
  return hlsStatus.get(entryId) || {
    status: "idle",
    percent: 0,
    message: "Aguardando processamento HLS.",
    source: null,
    qualities: []
  };
}

async function prepareHls(entry, analysis) {
  const finalHls = getHlsPaths(entry.entryId);
  const renditions = getHlsRenditions(analysis);
  const existingQualities = readHlsQualities(finalHls.masterPath);
  const hasEveryRendition = renditions.every((rendition) => existingQualities.includes(rendition.height));
  if (fs.existsSync(finalHls.masterPath) && hasEveryRendition) {
    return finalHls;
  }
  if (hlsJobs.has(entry.entryId)) {
    return hlsJobs.get(entry.entryId);
  }

  hlsStatus.set(entry.entryId, {
    status: "processing",
    percent: 0,
    message: "Iniciando processamento HLS...",
    source: null,
    qualities: renditions.map((item) => item.height)
  });

  const job = (async () => {
    const startedAt = Date.now();
    const tempHls = getHlsPaths(entry.entryId, true);
    const totalSteps = Math.max(1, analysis.audioTracks.length + renditions.length);
    let completedSteps = 0;
    await ensureHlsDiskSpace(analysis.sourcePath, analysis, renditions);
    await removeDirectoryIfExists(tempHls.folder);
    fs.mkdirSync(tempHls.folder, { recursive: true });
    console.log(`[HLS] inicio id=${entry.entryId} origem=${analysis.width}x${analysis.height} rendicoes=${renditions.map((item) => item.name).join(",")}`);

    const updateProgress = (message, progress, extra = {}) => {
      const currentStep = Math.max(0, Math.min(99, progress));
      hlsStatus.set(entry.entryId, {
        status: "processing",
        percent: Math.min(99, Math.round(((completedSteps + currentStep / 100) / totalSteps) * 100)),
        message,
        source: null,
        qualities: renditions.map((item) => item.height),
        ...extra
      });
    };

    for (const track of analysis.audioTracks) {
      const audioFolder = path.join(tempHls.folder, "audio", getAudioTrackKey(track));
      fs.mkdirSync(audioFolder, { recursive: true });
      updateProgress(`Preparando audio ${track.displayLanguage || track.language}...`, 0);
      await runFfmpeg([
        "-y", "-i", analysis.sourcePath,
        "-map", `0:${track.ffmpegStreamIndex}`,
        "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-hls_time", "4", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", path.join(audioFolder, "segment_%05d.m4s"),
        path.join(audioFolder, "index.m3u8")
      ], (progress) => {
        const outSeconds = parseTimestampToSeconds(progress.out_time);
        const percent = analysis.durationSeconds > 0 ? (outSeconds / analysis.durationSeconds) * 100 : 0;
        updateProgress(`Preparando audio ${track.displayLanguage || track.language}...`, percent);
      }, { cwd: audioFolder });
      completedSteps += 1;
    }

    for (const rendition of renditions) {
      const videoFolder = path.join(tempHls.folder, rendition.name);
      const resolution = getHlsResolution(analysis, rendition);
      fs.mkdirSync(videoFolder, { recursive: true });
      updateProgress(`Gerando qualidade ${rendition.name}...`, 0);
      await runFfmpeg([
        "-y", "-i", analysis.sourcePath,
        "-map", "0:v:0", "-an",
        "-vf", `scale=${resolution.width}:${resolution.height}`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-maxrate", rendition.maxRate, "-bufsize", rendition.bufferSize,
        "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", rendition.level,
        "-sc_threshold", "0", "-force_key_frames", "expr:gte(t,n_forced*4)",
        "-hls_time", "4", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", path.join(videoFolder, "segment_%05d.m4s"),
        path.join(videoFolder, "index.m3u8")
      ], (progress) => {
        const outSeconds = parseTimestampToSeconds(progress.out_time);
        const percent = analysis.durationSeconds > 0 ? (outSeconds / analysis.durationSeconds) * 100 : 0;
        updateProgress(`Gerando qualidade ${rendition.name}...`, percent);
      }, { cwd: videoFolder });
      completedSteps += 1;
    }

    await fsp.writeFile(tempHls.masterPath, buildHlsMasterPlaylist(analysis, renditions));
    await removeDirectoryIfExists(finalHls.folder);
    await fsp.rename(tempHls.folder, finalHls.folder);
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    hlsStatus.set(entry.entryId, {
      status: "ready",
      percent: 100,
      message: "Streaming adaptativo pronto.",
      source: finalHls.publicSrc,
      qualities: renditions.map((item) => item.height)
    });
    console.log(`[HLS] concluido id=${entry.entryId} tempo=${elapsedSeconds}s rendicoes=${renditions.map((item) => item.name).join(",")}`);
    return finalHls;
  })().catch(async (error) => {
    hlsStatus.set(entry.entryId, {
      status: "error",
      percent: 0,
      message: "Falha no processamento HLS. Consulte os logs do servidor.",
      source: null,
      qualities: []
    });
    console.error(`[HLS] erro id=${entry.entryId}: ${summarizeProcessError(error)}`);
    await removeDirectoryIfExists(getHlsPaths(entry.entryId, true).folder);
    throw error;
  }).finally(() => {
    hlsJobs.delete(entry.entryId);
  });

  hlsJobs.set(entry.entryId, job);
  return job;
}

function getPreparedSubtitlePath(entryId, subtitleIndex) {
  const folder = path.join(STREAMS_DIR, entryId, "subtitles");
  const filePath = path.join(folder, `subtitle-${subtitleIndex}.vtt`);
  return {
    folder,
    filePath,
    publicSrc: `/streams/${entryId}/subtitles/subtitle-${subtitleIndex}.vtt`
  };
}

async function prepareSubtitle(entry, analysis, subtitleIndex) {
  const track = analysis.subtitleTracks[subtitleIndex];
  if (!track || track.kind !== "subtitles") {
    return null;
  }

  const subtitle = getPreparedSubtitlePath(entry.entryId, subtitleIndex);
  if (fs.existsSync(subtitle.filePath)) {
    return subtitle;
  }

  const jobKey = `${entry.entryId}:subtitle:${subtitleIndex}`;
  if (subtitleJobs.has(jobKey)) {
    return subtitleJobs.get(jobKey);
  }

  const job = (async () => {
    fs.mkdirSync(subtitle.folder, { recursive: true });
    const tempPath = `${subtitle.filePath}.tmp.vtt`;
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }

    subtitleStatus.set(jobKey, {
      status: "preparing",
      message: "Preparando legenda...",
      subtitleIndex
    });

    try {
      await runFfmpeg(
        [
          "-y",
          "-i",
          analysis.sourcePath,
          "-map",
          `0:${track.ffmpegStreamIndex}`,
          "-c:s",
          "webvtt",
          tempPath
        ]
      );
      fs.renameSync(tempPath, subtitle.filePath);
      subtitleStatus.set(jobKey, {
        status: "ready",
        message: "Legenda pronta.",
        subtitleIndex
      });
      return subtitle;
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
      subtitleStatus.set(jobKey, {
        status: "error",
        message: "Falha ao preparar legenda.",
        subtitleIndex
      });
      throw error;
    }
  })().finally(() => {
    subtitleJobs.delete(jobKey);
  });

  subtitleJobs.set(jobKey, job);
  return job;
}

function getSubtitleSnapshot(entryId, subtitleTracks) {
  return subtitleTracks.map((track) => {
    const jobKey = `${entryId}:subtitle:${track.index}`;
    const subtitle = getPreparedSubtitlePath(entryId, track.index);
    const ready = track.kind === "subtitles" && fs.existsSync(subtitle.filePath);
    return {
      ...track,
      status: ready ? "ready" : subtitleStatus.get(jobKey)?.status || (track.kind === "subtitles" ? "idle" : "unsupported"),
      message:
        ready
          ? "Legenda pronta."
          : subtitleStatus.get(jobKey)?.message ||
            (track.kind === "subtitles" ? "Aguardando legenda." : "Formato de legenda nao suportado pelo navegador."),
      src: ready ? subtitle.publicSrc : null
    };
  });
}

function runFfmpeg(args, onProgress, spawnOptions = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [...args, "-progress", "pipe:1", "-nostats"], {
      windowsHide: true,
      ...spawnOptions
    });
    let stderr = "";
    let stdoutBuffer = "";

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      const progress = {};
      for (const line of lines) {
        const [key, rawValue] = line.split("=");
        if (!key) {
          continue;
        }
        progress[key.trim()] = (rawValue || "").trim();
      }

      if (Object.keys(progress).length && onProgress) {
        onProgress(progress);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

async function prepareVariant(entry, analysis, audioIndex) {
  const selectedTrack = analysis.audioTracks[audioIndex] || analysis.audioTracks[0];
  if (!selectedTrack) {
    throw new Error("Nenhuma faixa de áudio compatível foi encontrada.");
  }

  const variant = getPreparedVariantPath(entry.entryId, selectedTrack);
  if (fs.existsSync(variant.filePath)) {
    return variant;
  }

  const jobKey = `${entry.entryId}:audio:${getAudioTrackKey(selectedTrack)}`;
  if (prepareJobs.has(jobKey)) {
    return prepareJobs.get(jobKey);
  }

  const job = (async () => {
    fs.mkdirSync(variant.folder, { recursive: true });
    const tempPath = `${variant.filePath}.tmp.mp4`;
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }

    const mapAudio = `0:${selectedTrack.ffmpegStreamIndex}`;

    prepareStatus.set(jobKey, {
      status: "preparing",
      percent: 0,
      message: "Preparando versão compatível...",
      audioIndex
    });

    const handleProgress = (progress) => {
      const outSeconds = parseTimestampToSeconds(progress.out_time);
      const duration = analysis.durationSeconds || 0;
      const percent = duration > 0 ? Math.max(0, Math.min(99, Math.round((outSeconds / duration) * 100))) : 0;
      prepareStatus.set(jobKey, {
        status: "preparing",
        percent,
        message: percent > 0 ? `Convertendo... ${percent}%` : "Convertendo áudio e preparando vídeo...",
        audioIndex
      });
    };

    try {
      await runFfmpeg(
        [
          "-y",
          "-i",
          analysis.sourcePath,
          "-map",
          "0:v:0",
          "-map",
          mapAudio,
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          tempPath
        ],
        handleProgress
      );
    } catch {
      await runFfmpeg(
        [
          "-y",
          "-i",
          analysis.sourcePath,
          "-map",
          "0:v:0",
          "-map",
          mapAudio,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          tempPath
        ],
        handleProgress
      );
    }

    fs.renameSync(tempPath, variant.filePath);
    prepareStatus.set(jobKey, {
      status: "ready",
      percent: 100,
      message: "Versão compatível pronta.",
      audioIndex
    });
    return variant;
  })().finally(() => {
    prepareJobs.delete(jobKey);
  });

  prepareJobs.set(jobKey, job);
  return job;
}

function getPreparationSnapshot(entryId, audioTracks) {
  return audioTracks.map((track) => {
    const jobKey = `${entryId}:audio:${getAudioTrackKey(track)}`;
    const variant = getPreparedVariantPath(entryId, track);
    if (fs.existsSync(variant.filePath)) {
      return {
        audioIndex: track.index,
        status: "ready",
        percent: 100,
        message: "Versão compatível pronta."
      };
    }

    return (
      prepareStatus.get(jobKey) || {
        audioIndex: track.index,
        status: "idle",
        percent: 0,
        message: "Aguardando preparação."
      }
    );
  });
}

async function queuePreparationForEntry(entryId) {
  const library = await readLibrary();
  const entry = findEntryById(library, entryId);
  if (!entry) {
    return;
  }

  const analysis = await analyzePlayback(entry);
  const preferredTrack = getPreferredAudioOrder(analysis.audioTracks)[0];
  if (analysis.requiresPreparedStream && preferredTrack) {
    try {
      await prepareVariant(entry, analysis, preferredTrack.index);
    } catch {
      prepareStatus.set(`${entry.entryId}:audio:${getAudioTrackKey(preferredTrack)}`, {
        status: "error",
        percent: 0,
        message: "Falha na preparação.",
        audioIndex: preferredTrack.index
      });
    }
  }

  await prepareHls(entry, analysis);
}

function enqueuePreparationForEntry(entryId) {
  if (queuedPreparationJobs.has(entryId)) {
    return queuedPreparationJobs.get(entryId);
  }

  if (getHlsSnapshot(entryId).status === "idle") {
    hlsStatus.set(entryId, {
      status: "processing",
      percent: 0,
      message: "Video na fila de otimizacao...",
      source: null,
      qualities: []
    });
  }

  const queuedJob = mediaProcessingQueue
    .then(() => queuePreparationForEntry(entryId))
    .finally(() => queuedPreparationJobs.delete(entryId));
  queuedPreparationJobs.set(entryId, queuedJob);
  mediaProcessingQueue = queuedJob.catch((error) => {
    console.error(`[MIDIA] falha no processamento id=${entryId}: ${summarizeProcessError(error)}`);
  });
  return queuedJob;
}

app.get("/api/library", async (req, res) => {
  res.json(await readLibrary());
});

app.get("/api/uploads/status/:uploadId", (req, res) => {
  const status = uploadProgress.get(req.params.uploadId);
  if (!status) {
    return res.status(404).json({ error: "Upload nao encontrado." });
  }

  return res.json(status);
});

app.get("/api/hls/status/:entryId", async (req, res) => {
  const library = await readLibrary();
  const entry = findEntryById(library, req.params.entryId);
  if (!entry) {
    return res.status(404).json({ error: "Mídia não encontrada." });
  }
  return res.json(getHlsSnapshot(entry.entryId));
});

app.get("/api/playback/:entryId", async (req, res) => {
  try {
    const library = await readLibrary();
    const entry = findEntryById(library, req.params.entryId);
    if (!entry) {
      return res.status(404).json({ error: "Mídia não encontrada." });
    }

    const analysis = await analyzePlayback(entry);
    const requestedAudio = Number(req.query.audio || 0);
    const audioIndex = Math.max(0, Math.min(requestedAudio, Math.max(analysis.audioTracks.length - 1, 0)));
    for (const subtitle of analysis.subtitleTracks) {
      if (subtitle.kind === "subtitles") {
        prepareSubtitle(entry, analysis, subtitle.index).catch(() => {});
      }
    }
    const subtitleTracks = getSubtitleSnapshot(entry.entryId, analysis.subtitleTracks);
    const selectedTrack = analysis.audioTracks[audioIndex] || analysis.audioTracks[0];
    const fallbackVariant = selectedTrack ? getPreparedVariantPath(entry.entryId, selectedTrack) : null;
    const fallbackSource = !analysis.requiresPreparedStream
      ? entry.sourceSrc
      : fallbackVariant && fs.existsSync(fallbackVariant.filePath)
        ? fallbackVariant.publicSrc
        : null;
    let hls = getHlsSnapshot(entry.entryId);
    const expectedQualities = getHlsRenditions(analysis).map((rendition) => rendition.height);
    const needsQualityUpgrade = expectedQualities.some((height) => !hls.qualities.includes(height));
    if (hls.status === "idle" || needsQualityUpgrade) {
      enqueuePreparationForEntry(entry.entryId).catch(() => {});
      hls = getHlsSnapshot(entry.entryId);
    }

    if (hls.status === "ready") {
      return res.json({
        status: "ready",
        playbackType: "hls",
        source: hls.source,
        fallbackSource,
        audioTracks: analysis.audioTracks,
        subtitleTracks,
        selectedAudio: 0,
        qualities: hls.qualities,
        hls,
        direct: false,
        preparation: getPreparationSnapshot(entry.entryId, analysis.audioTracks)
      });
    }

    if (!analysis.requiresPreparedStream) {
      return res.json({
        status: "ready",
        playbackType: "direct",
        source: entry.sourceSrc,
        audioTracks: analysis.audioTracks,
        subtitleTracks,
        selectedAudio: audioIndex,
        qualities: [],
        hls,
        direct: true,
        preparation: getPreparationSnapshot(entry.entryId, analysis.audioTracks)
      });
    }

    if (!selectedTrack) {
      return res.status(422).json({
        error: "Nenhuma faixa em Português, Inglês ou no áudio original foi encontrada."
      });
    }

    const variant = getPreparedVariantPath(entry.entryId, selectedTrack);
    if (fs.existsSync(variant.filePath)) {
      return res.json({
        status: "ready",
        playbackType: "direct",
        source: variant.publicSrc,
        audioTracks: analysis.audioTracks,
        subtitleTracks,
        selectedAudio: audioIndex,
        qualities: [],
        hls,
        direct: false,
        preparation: getPreparationSnapshot(entry.entryId, analysis.audioTracks)
      });
    }

    prepareVariant(entry, analysis, audioIndex).catch(() => {});
    return res.status(202).json({
      status: "preparing",
      playbackType: "direct",
      message: "Preparando versão compatível para reprodução.",
      audioTracks: analysis.audioTracks,
      subtitleTracks,
      selectedAudio: audioIndex,
      qualities: [],
      hls,
      direct: false,
      preparation: getPreparationSnapshot(entry.entryId, analysis.audioTracks)
    });
  } catch (error) {
    return res.status(500).json({ error: "Falha ao preparar reprodução.", details: error.message });
  }
});

app.post(
  "/api/upload/movie",
  createUploadTracker,
  upload.fields([{ name: "video", maxCount: 1 }, { name: "cover", maxCount: 1 }]),
  async (req, res) => {
    const file = req.files?.video?.[0];
    const coverFile = req.files?.cover?.[0] || null;

    if (!file) {
      return res.status(400).json({ error: "Selecione um arquivo de vídeo." });
    }

    markUploadProgress(req.uploadId, { status: "processing" });

    const item = buildMovieItem(file, req.body, coverFile);
    await updateLibrary((library) => {
      library.items.unshift(item);
    });

    enqueuePreparationForEntry(item.id).catch(() => {});
    res.status(201).json({ item });
  }
);

app.post(
  "/api/upload/series",
  createUploadTracker,
  upload.fields([{ name: "episodes", maxCount: 100 }, { name: "cover", maxCount: 1 }]),
  async (req, res) => {
    const files = (req.files?.episodes || []).slice().sort((a, b) =>
      a.originalname.localeCompare(b.originalname, undefined, { numeric: true, sensitivity: "base" })
    );
    const coverFile = req.files?.cover?.[0] || null;
    const { title, genre, year, synopsis, seasonNumber } = req.body;

    if (!title || files.length === 0) {
      await removeDirectoryIfExists(path.join(UPLOADS_DIR, req.uploadFolderName || ""));
      return res.status(400).json({ error: "Informe o título da série e envie pelo menos um episódio." });
    }

    markUploadProgress(req.uploadId, { status: "processing" });

    const item = buildSeriesItem(files, { title, genre, year, synopsis, seasonNumber }, coverFile);
    await updateLibrary((library) => {
      library.items.unshift(item);
    });

    for (const episode of item.episodes) {
      enqueuePreparationForEntry(episode.id).catch(() => {});
    }

    res.status(201).json({ item });
  }
);

app.post("/api/media/:id/cover", (req, res, next) => {
  coverUpload.single("cover")(req, res, (error) => {
    if (error) {
      if (error.message === "MEDIA_NOT_FOUND") {
        res.status(404).json({ error: "Mídia não encontrada." });
        return;
      }
      next(error);
      return;
    }
    next();
  });
}, async (req, res) => {
  const coverFile = req.file;
  if (!coverFile) {
    return res.status(400).json({ error: "Selecione uma imagem de capa." });
  }

  const updated = await updateLibrary((library) => {
    const item = library.items.find((entry) => entry.id === req.params.id);
    if (!item) {
      return null;
    }

    const previousCoverPath = item.cover?.src ? srcToAbsolutePath(item.cover.src) : null;
    item.cover = coverToData(coverFile);
    return { item, previousCoverPath };
  });

  if (!updated) {
    return res.status(404).json({ error: "Mídia não encontrada." });
  }

  if (updated.previousCoverPath && updated.previousCoverPath !== coverFile.path) {
    fsp.unlink(updated.previousCoverPath).catch(() => {});
  }

  res.status(200).json({ item: updated.item });
});

app.delete("/api/media/:id", async (req, res) => {
  const removed = await updateLibrary((library) => {
    const item = library.items.find((entry) => entry.id === req.params.id);
    if (!item) {
      return null;
    }
    library.items = library.items.filter((entry) => entry.id !== req.params.id);
    return item;
  });

  if (!removed) {
    return res.status(404).json({ error: "Mídia não encontrada." });
  }

  const uploadRemoved = await removeDirectoryIfExists(path.join(UPLOADS_DIR, removed.folder));
  const streamRemoved = await removeDirectoryIfExists(path.join(STREAMS_DIR, removed.id));

  if (!uploadRemoved || !streamRemoved) {
    return res.status(409).json({
      error: "A mídia foi removida do catálogo, mas os arquivos ainda estão em uso. Feche o player e tente apagar novamente em alguns segundos."
    });
  }

  res.status(204).send();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  if (!accessProtectionEnabled) {
    console.warn("[SEGURANCA] APP_USERNAME/APP_PASSWORD nao definidos; catalogo e videos estao sem autenticacao no Express.");
  }
});
