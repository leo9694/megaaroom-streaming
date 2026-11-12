const fs = require("node:fs/promises");
const path = require("node:path");

function mediaIds(item) { return [item.id, ...(item.episodes || []).map((episode) => episode.id)]; }

function uploadFolders(item) {
  const files = [item.video, item.cover, ...(item.episodes || [])];
  const sources = files.map((file) => /^\/uploads\/([\w-]+)\//.exec(file?.src || "")?.[1]);
  return [item.folder, ...(item.uploadFolders || []), ...(item.episodes || []).map((episode) => episode.folder), ...sources].filter(Boolean);
}

async function cleanupMediaFiles(root, item, removeDirectory, remaining = []) {
  const ids = new Set(mediaIds(item));
  const safe = (folder, name) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name || "")) throw new Error("Identificador de arquivo invalido.");
    const base = path.resolve(root, folder) + path.sep;
    const target = path.resolve(base, name);
    if (!target.startsWith(base)) throw new Error("Caminho fora da biblioteca.");
    return target;
  };
  const targets = new Set([...ids].map((id) => safe("streams", id)));
  // Some migrated catalogues reference the same original from multiple items.
  const sharedFolders = new Set(remaining.flatMap(uploadFolders));
  for (const folder of uploadFolders(item)) if (!sharedFolders.has(folder)) targets.add(safe("uploads", folder));
  const ticketFiles = [];
  for (const directory of ["local-tickets", "existing-tickets"]) {
    const folder = path.join(root, "data", directory);
    let names;
    try { names = await fs.readdir(folder); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names) {
      if (!/^[a-f0-9]{48}\.json$/.test(name)) continue;
      const file = path.join(folder, name);
      const ticket = JSON.parse(await fs.readFile(file, "utf8"));
      if (ids.has(ticket.entryId) || ticket.targetSeriesId === item.id || ticket.result?.item?.id === item.id || name === item.localImportId + ".json") {
        ticketFiles.push(file);
        const stagingFolder = "local-" + name.slice(0, -5);
        if (directory === "local-tickets" && !sharedFolders.has(stagingFolder)) targets.add(safe("uploads", stagingFolder));
      }
    }
  }
  // Keep the catalogue record until every directory has been removed successfully.
  for (const target of targets) if (!await removeDirectory(target)) throw new Error("Arquivos em uso. Feche o player e tente apagar novamente.");
  for (const file of ticketFiles) await fs.rm(file, { force: true });
}

function catalogueReferences(library) {
  if (!Array.isArray(library?.items)) throw new Error("Catalogo invalido; limpeza ignorada.");
  const streams = new Set();
  const uploads = new Set();
  for (const item of library.items) {
    for (const id of mediaIds(item)) {
      if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new Error("Catalogo com ID invalido; limpeza ignorada.");
      streams.add(id);
    }
    for (const folder of uploadFolders(item)) uploads.add(folder);
  }
  return { streams, uploads };
}

async function recoverMediaStorage(root, library, removeDirectory, logger = console) {
  const references = catalogueReferences(library);
  const managed = { streams: /^(?:movie|series|episode)_\d{13}_[a-z0-9]{1,8}$/,
    uploads: /^(?:\d{13}_[a-z0-9]{1,8}|local-[a-f0-9]{48})$/ };
  let removed = 0;
  const recover = async (target, operation) => {
    try {
      if (await operation(target) === false) throw new Error("Arquivo em uso.");
      removed++;
    } catch (error) { logger.error(`[LIMPEZA] ${path.relative(root, target)}: ${error.message}`); }
  };
  const deleteFile = (file) => fs.rm(file, { force: true });
  const contents = async (folder, device) => {
    const info = await fs.lstat(folder).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (!info?.isDirectory() || (device !== undefined && info.dev !== device)) return [];
    return fs.readdir(folder, { withFileTypes: true });
  };

  for (const directory of ["uploads", "streams"]) {
    const base = path.resolve(root, directory);
    const device = (await fs.lstat(base)).dev;
    for (const entry of await contents(base)) {
      if (!entry.isDirectory() || !managed[directory].test(entry.name)) continue;
      const folder = path.join(base, entry.name);
      if ((await fs.lstat(folder)).dev !== device) continue;
      if (!references[directory].has(entry.name)) {
        await recover(folder, removeDirectory);
        continue;
      }
      for (const file of await contents(folder, device)) {
        const target = path.join(folder, file.name);
        if (directory === "uploads") {
          if (file.isDirectory() && file.name === "prepared" && entry.name.startsWith("local-")) await recover(target, removeDirectory);
          continue;
        }
        if (file.isDirectory() && (file.name === ".hls-tmp" || /^\.local-[a-f0-9]{48}$/.test(file.name))) {
          await recover(target, removeDirectory);
        } else if (file.isFile() && /^(?:original-)?audio-stream-\d+\.mp4\.tmp\.mp4$/.test(file.name)) {
          await recover(target, deleteFile);
        } else if (file.isDirectory() && ["subtitles", "hls"].includes(file.name)) {
          for (const temp of await contents(target, device)) {
            if (temp.isFile() && (file.name === "subtitles" ? /^subtitle-\d+\.vtt\.tmp\.vtt$/.test(temp.name) : temp.name === "master.m3u8.tmp")) {
              await recover(path.join(target, temp.name), deleteFile);
            }
          }
        }
      }
    }
  }
  return removed;
}

module.exports = { cleanupMediaFiles, mediaIds, uploadFolders, catalogueReferences, recoverMediaStorage };
