(function (root) {
  function createEtaEstimator({ now = () => performance.now() } = {}) {
    let key;
    let samples = [];
    let lastValue;
    let lastAdvance = 0;
    let lastSeen = 0;
    return {
      reset() { key = undefined; samples = []; lastValue = undefined; },
      update({ phaseKey, completed, total, processing = false }) {
        const at = now();
        const windowMs = processing ? 180000 : 60000;
        if (!Number.isFinite(completed) || completed < 0 || !Number.isFinite(total) || total <= 0) return { status: "calculating" };
        if (phaseKey !== key || completed < lastValue || at - lastSeen > windowMs || samples[0]?.total !== total) {
          key = phaseKey; samples = [{ at, value: completed, total }]; lastValue = completed; lastAdvance = at;
        }
        lastSeen = at;
        if (completed > lastValue) lastAdvance = at;
        lastValue = completed;
        if (completed >= total) return { status: "finishing" };
        if (at - lastAdvance > (processing ? 120000 : 15000)) return { status: "waiting" };
        if (at - samples[samples.length - 1].at >= 1000) samples.push({ at, value: completed, total });
        while (samples.length > 2 && samples[1].at < at - windowMs) samples.shift();
        const first = samples[0];
        const elapsed = (at - first.at) / 1000;
        const advanced = completed - first.value;
        if (elapsed < 5 || advanced <= 0) return { status: "calculating" };
        const seconds = (total - completed) / (advanced / elapsed);
        return Number.isFinite(seconds) && seconds > 0 ? { status: "estimated", seconds } : { status: "calculating" };
      }
    };
  }

  function formatEta(result, label) {
    if (result.status === "calculating") return "Calculando previsao pelo desempenho atual...";
    if (result.status === "waiting") return "Previsao indisponivel: aguardando novos dados de progresso.";
    if (result.status === "finishing") return "Finalizando esta etapa. Aguardando confirmacao...";
    const minutes = Math.ceil(result.seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    const time = result.seconds < 60 ? "menos de 1 minuto" : minutes === 1 ? "cerca de 1 minuto"
      : minutes < 60 ? `cerca de ${minutes} minutos`
      : `cerca de ${hours} ${hours === 1 ? "hora" : "horas"}${remainder ? ` e ${remainder} ${remainder === 1 ? "minuto" : "minutos"}` : ""}`;
    return `Concluindo ${label} em ${time}.`;
  }
  function selectJobs(jobs, showHistory) {
    const pending = jobs.filter((job) => !["done", "error"].includes(job.status)).slice(0, 20);
    const failures = jobs.filter((job) => job.status === "error").slice(-20);
    const completed = jobs.filter((job) => job.status === "done");
    return { jobs: [...pending, ...failures, ...(showHistory ? completed.slice(-50) : [])], completedCount: completed.length };
  }
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
  if (typeof module === "object" && module.exports) module.exports = { copyToHelper, selectJobs, createEtaEstimator, formatEta };
  else root.MegaRoomLocalTransfer = { copyToHelper, selectJobs, createEtaEstimator, formatEta };
})(typeof window === "object" ? window : globalThis);
