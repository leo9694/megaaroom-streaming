(function (root) {
  function copyToHelper({ url, key, body, onProgress, XMLHttpRequestImpl = root.XMLHttpRequest, now = () => performance.now() }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequestImpl();
      let loaded = 0;
      let total = 0;
      let previousLoaded = 0;
      let previousAt = now();
      let speed = 0;
      let settled = false;
      const report = (phase) => onProgress({ phase, loaded, total, speed,
        percent: total > 0 ? Math.min(100, loaded / total * 100) : null });
      const fail = (message) => {
        if (settled) return;
        settled = true; report("error"); reject(new Error(message));
      };
      xhr.open("POST", url);
      xhr.setRequestHeader("X-Local-Key", key);
      xhr.upload.addEventListener("progress", (event) => {
        loaded = event.loaded;
        total = event.lengthComputable ? event.total : 0;
        const at = now();
        const elapsed = (at - previousAt) / 1000;
        if (elapsed >= 0.25) {
          speed = Math.max(0, (loaded - previousLoaded) / elapsed);
          previousAt = at; previousLoaded = loaded;
        }
        report("copying");
      });
      xhr.upload.addEventListener("load", () => { speed = 0; report("confirming"); });
      xhr.addEventListener("load", () => {
        let payload;
        try { payload = JSON.parse(xhr.responseText); }
        catch { fail("O auxiliar retornou uma resposta invalida."); return; }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(payload.error || `Auxiliar respondeu ${xhr.status}.`); return;
        }
        settled = true; speed = 0; report("done"); resolve(payload);
      });
      xhr.addEventListener("error", () => fail("A copia foi interrompida. Verifique se o auxiliar continua aberto e se o navegador permitiu acesso local."));
      xhr.addEventListener("abort", () => fail("Copia cancelada antes da confirmacao do auxiliar."));
      report("copying");
      xhr.send(body);
    });
  }
  if (typeof module === "object" && module.exports) module.exports = { copyToHelper };
  else root.MegaRoomLocalTransfer = { copyToHelper };
})(typeof window === "object" ? window : globalThis);
