const fs = require("node:fs/promises");
const path = require("node:path");

function mediaIds(item) { return [item.id, ...(item.episodes || []).map((episode) => episode.id)]; }

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
  if (item.folder && !remaining.some((entry) => entry.folder === item.folder)) targets.add(safe("uploads", item.folder));
  const ticketFiles = [];
  for (const directory of ["local-tickets", "existing-tickets"]) {
    const folder = path.join(root, "data", directory);
    let names;
    try { names = await fs.readdir(folder); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names) {
      if (!/^[a-f0-9]{48}\.json$/.test(name)) continue;
      const file = path.join(folder, name);
      const ticket = JSON.parse(await fs.readFile(file, "utf8"));
      if (ids.has(ticket.entryId) || ticket.result?.item?.id === item.id || name === item.localImportId + ".json") {
        ticketFiles.push(file);
        const stagingFolder = "local-" + name.slice(0, -5);
        if (directory === "local-tickets" && !remaining.some((entry) => entry.folder === stagingFolder)) targets.add(safe("uploads", stagingFolder));
      }
    }
  }
  // Keep the catalogue record until every directory has been removed successfully.
  for (const target of targets) if (!await removeDirectory(target)) throw new Error("Arquivos em uso. Feche o player e tente apagar novamente.");
  for (const file of ticketFiles) await fs.rm(file, { force: true });
}

module.exports = { cleanupMediaFiles, mediaIds };
