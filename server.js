const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");
const { execFile, spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const STREAMS_DIR = path.join(ROOT, "streams");
const LIBRARY_FILE = path.join(DATA_DIR, "library.json");

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
  if (!req.path.startsWith("/uploads/") && !req.path.startsWith("/streams/")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/streams", express.static(STREAMS_DIR));
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

function absolutePathToPublicSrc(filePath) {
  const relative = path.relative(ROOT, filePath).split(path.sep).join("/");
  return `/${relative}`;
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
  return absolutePathToPublicSrc(file.path);
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

function ensureImportFolder(req, coverFile, preferredFolderName) {
  if (coverFile?.path) {
    return path.basename(path.dirname(coverFile.path));
  }

  const folderName = preferredFolderName || ensureRequestFolder(req);
  fs.mkdirSync(path.join(UPLOADS_DIR, folderName), { recursive: true });
  return folderName;
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

function getPreferredAudioOrder(audioTracks) {
  const scored = audioTracks.map((track, index) => {
    const language = String(track.language || "").toLowerCase();
    let score = 100 + index;
    if (language.includes("portugu")) {
      score = 0;
    } else if (language.includes("ingl")) {
      score = 10;
    } else if (language.includes("espan")) {
      score = 20;
    }
    return { track, score };
  });

  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.track);
}

function findEntryById(library, entryId) {
  for (const item of library.items) {
    if (item.id === entryId) {
      return {
        entryId,
        kind: "movie",
        mediaId: item.id,
        parent: item,
        originalName: item.video.originalName,
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
        originalName: episode.originalName,
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
  const resolvedSource = await resolveEntrySource(entry);
  const sourcePath = resolvedSource.path;
  const cacheKey = `${entry.entryId}:${sourcePath}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const probe = await ffprobeJson(sourcePath);
  const audioTracks = (probe.streams || [])
    .filter((stream) => stream.codec_type === "audio")
    .map((stream, index) => ({
      index,
      ffmpegStreamIndex: stream.index,
      codec: stream.codec_name || "unknown",
      language: normalizeLanguage(stream.tags?.language),
      title: stream.tags?.title || `Faixa ${index + 1}`,
      channels: stream.channels || null
    }));

  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const analysis = {
    sourcePath,
    sourcePublicSrc: resolvedSource.publicSrc,
    sourceExt: path.extname(sourcePath).toLowerCase(),
    videoCodec: videoStream?.codec_name || "",
    durationSeconds: Number(probe.format?.duration || 0),
    audioTracks,
    requiresPreparedStream:
      path.extname(sourcePath).toLowerCase() !== ".mp4" ||
      audioTracks.length > 1 ||
      (videoStream?.codec_name || "") !== "h264"
  };

  analysisCache.set(cacheKey, analysis);
  return analysis;
}

function getPreparedVariantPath(entryId, audioIndex) {
  const folder = path.join(STREAMS_DIR, entryId);
  const filePath = path.join(folder, `audio-${audioIndex}.mp4`);
  return {
    folder,
    filePath,
    publicSrc: `/streams/${entryId}/audio-${audioIndex}.mp4`
  };
}

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [...args, "-progress", "pipe:1", "-nostats"], { windowsHide: true });
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
  const variant = getPreparedVariantPath(entry.entryId, audioIndex);
  if (fs.existsSync(variant.filePath)) {
    return variant;
  }

  const jobKey = `${entry.entryId}:${audioIndex}`;
  if (prepareJobs.has(jobKey)) {
    return prepareJobs.get(jobKey);
  }

  const job = (async () => {
    fs.mkdirSync(variant.folder, { recursive: true });
    const tempPath = `${variant.filePath}.tmp.mp4`;
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }

    const selectedTrack = analysis.audioTracks[audioIndex] || analysis.audioTracks[0];
    const mapAudio = selectedTrack ? `0:${selectedTrack.ffmpegStreamIndex}` : "0:a:0";

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
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
      prepareStatus.set(jobKey, {
        status: "error",
        percent: 0,
        message: `Falha na preparação: ${error.message}`,
        audioIndex
      });
      throw error;
    }
  })().finally(() => {
    prepareJobs.delete(jobKey);
  });

  prepareJobs.set(jobKey, job);
  return job;
}

function getPreparationSnapshot(entryId, audioTracks) {
  return audioTracks.map((track) => {
    const jobKey = `${entryId}:${track.index}`;
    const variant = getPreparedVariantPath(entryId, track.index);
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
  if (!analysis.requiresPreparedStream) {
    return;
  }

  const preferredTrack = getPreferredAudioOrder(analysis.audioTracks)[0];
  if (!preferredTrack) {
    return;
  }

  prepareVariant(entry, analysis, preferredTrack.index).catch(() => {
    prepareStatus.set(`${entry.entryId}:${preferredTrack.index}`, {
      status: "error",
      percent: 0,
      message: "Falha na preparação.",
      audioIndex: preferredTrack.index
    });
  });
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

    if (!analysis.requiresPreparedStream) {
      return res.json({
        status: "ready",
        source: analysis.sourcePublicSrc,
        audioTracks: analysis.audioTracks,
        selectedAudio: audioIndex,
        direct: true,
        preparation: getPreparationSnapshot(entry.entryId, analysis.audioTracks)
      });
    }

    const variant = getPreparedVariantPath(entry.entryId, audioIndex);
    if (fs.existsSync(variant.filePath)) {
      return res.json({
        status: "ready",
        source: variant.publicSrc,
        audioTracks: analysis.audioTracks,
        selectedAudio: audioIndex,
        direct: false,
        preparation: getPreparationSnapshot(entry.entryId, analysis.audioTracks)
      });
    }

    prepareVariant(entry, analysis, audioIndex).catch(() => {});
    return res.status(202).json({
      status: "preparing",
      message: "Preparando versão compatível para reprodução.",
      audioTracks: analysis.audioTracks,
      selectedAudio: audioIndex,
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

    queuePreparationForEntry(item.id).catch(() => {});
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
      queuePreparationForEntry(episode.id).catch(() => {});
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

    const previousCoverPath = item.cover?.src ? publicSrcToAbsolutePath(item.cover.src) : null;
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
  const streamTargets = removed.type === "series" ? (removed.episodes || []).map((episode) => episode.id) : [removed.id];
  const streamResults = await Promise.all(
    streamTargets.map((streamId) => removeDirectoryIfExists(path.join(STREAMS_DIR, streamId)))
  );
  if (!uploadRemoved || streamResults.some((result) => !result)) {
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
});

