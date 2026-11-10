const path = require("node:path");

function createUploadCleanup({ root, readLibrary, removeDirectory, logger = console }) {
  const uploads = path.resolve(root, "uploads") + path.sep;
  return (parse) => (req, res, next) => {
    let cleaning;
    const cleanup = () => {
      if (req.uploadHandling || req.uploadCommitted || !req.uploadFolderName) return Promise.resolve();
      if (cleaning) return cleaning;
      cleaning = (async () => {
        if (!/^[a-zA-Z0-9_-]+$/.test(req.uploadFolderName)) throw new Error("Pasta de upload invalida.");
        const folder = path.resolve(uploads, req.uploadFolderName);
        if (!folder.startsWith(uploads)) throw new Error("Pasta fora de uploads.");
        const library = await readLibrary();
        const referenced = library.items.some((item) => item.folder === req.uploadFolderName ||
          item.uploadFolders?.includes(req.uploadFolderName) || item.episodes?.some((episode) => episode.folder === req.uploadFolderName));
        if (!referenced && !await removeDirectory(folder)) throw new Error("Nao foi possivel remover upload incompleto.");
      })().catch((error) => logger.error("[UPLOAD] limpeza:", error.message)).finally(() => { cleaning = null; });
      return cleaning;
    };
    req.cleanupUpload = cleanup;
    res.once("finish", () => { if (!req.uploadCommitted) cleanup(); });
    res.once("close", () => { if (!req.uploadCommitted) cleanup(); });
    req.once("aborted", () => cleanup());
    return parse(req, res, async (error) => {
      if (!error) { next(); return; }
      await cleanup();
      if (!res.destroyed && !res.headersSent) res.status(400).json({ error: "Falha ao receber os arquivos: " + error.message });
    });
  };
}

function finishUpload(handler) {
  return async (req, res, next) => {
    req.uploadHandling = true;
    try { await handler(req, res); }
    catch (error) { next(error); }
    finally {
      req.uploadHandling = false;
      await req.cleanupUpload();
    }
  };
}

module.exports = { createUploadCleanup, finishUpload };
