(() => {
  const base = "http://127.0.0.1:43123";
  let key = localStorage.getItem("megaaroom-local-key") || "";
  let polling = false;
  let connected = false;
  let lastCompleted = "";
  let pollTimer;
  let canDelete = false;
  const panel = document.createElement("details");
  panel.className = "processing-options local-helper-panel";
  panel.innerHTML = `<summary>Processamento neste computador</summary>
    <p>Instale o auxiliar uma vez. Ele inclui FFmpeg e usa o PC para preparar e enviar os videos, mesmo se recarregar esta pagina.</p>
    <p><a href="/install-local.ps1" download>Baixar instalador para Windows</a> · <a href="/local-help.html" target="_blank" rel="noopener">Como instalar</a></p>
    <label>Codigo exibido pelo auxiliar<input type="password" class="local-pairing-key" autocomplete="off" /></label>
    <button type="button" class="mini-btn local-connect">Conectar auxiliar</button>
    <label>Uso de CPU do PC<select class="local-resource-profile" disabled><option>Conecte o auxiliar</option></select></label>
    <p class="local-resource-message" role="status">Escolha quanto do PC dedicar a conversao. Mais recursos podem deixar outros programas mais lentos.</p>
    <p class="local-helper-message" role="status"></p><div class="local-copy-list"></div><div class="local-job-list"></div>`;
  document.querySelector(".upload-card").append(panel);
  const message = panel.querySelector(".local-helper-message");
  const jobsList = panel.querySelector(".local-job-list");
  const input = panel.querySelector("input");
  const resourceSelect = panel.querySelector(".local-resource-profile");
  const resourceMessage = panel.querySelector(".local-resource-message");
  let savedProfile;
  const renderSettings = (settings) => {
    resourceSelect.replaceChildren();
    for (const profile of settings.profiles) {
      const option = document.createElement("option"); option.value = profile.id;
      option.textContent = `${profile.label} · ${profile.threads} thread(s)`;
      resourceSelect.append(option);
    }
    resourceSelect.value = savedProfile = settings.profile;
    resourceSelect.disabled = false;
    resourceMessage.textContent = `${settings.cpuCount} processadores logicos detectados. A escolha e salva neste PC e vale a partir da proxima etapa. Maximo pode deixar o PC ocupado; nao e uma porcentagem fixa de CPU.`;
  };
  resourceSelect.addEventListener("change", async () => {
    resourceSelect.disabled = true;
    try {
      renderSettings(await request("/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: resourceSelect.value }) }));
    } catch (error) { resourceSelect.value = savedProfile; resourceMessage.textContent = error.message; }
    finally { resourceSelect.disabled = false; }
  });
  const copyList = panel.querySelector(".local-copy-list");
  const jobCards = new Map();
  const transferSamples = new Map();
  const bytes = (value) => {
    if (!value) return "0 B";
    const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB"][unit]}`;
  };
  function progressCard(title) {
    const card = document.createElement("article"); card.className = "upload-item local-progress-card";
    card.innerHTML = `<strong></strong><div class="local-progress-heading"><span class="local-phase"></span><b class="local-percent"></b></div>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill"></div></div>
      <p class="local-transfer-numbers"></p><p class="local-progress-message" role="status"></p>`;
    card.querySelector("strong").textContent = title;
    const track = card.querySelector(".progress-track");
    const fill = card.querySelector(".progress-fill");
    return { card, update({ phase, percent = null, loaded = 0, total = 0, speed = 0, message = "", active = false, failed = false }) {
      const known = Number.isFinite(percent);
      card.dataset.active = String(active);
      card.dataset.failed = String(failed);
      card.querySelector(".local-phase").textContent = phase;
      card.querySelector(".local-percent").textContent = known ? `${Math.floor(percent)}%` : "";
      track.setAttribute("aria-label", phase);
      if (known) track.setAttribute("aria-valuenow", Math.floor(percent)); else track.removeAttribute("aria-valuenow");
      fill.style.width = known ? `${percent}%` : "35%";
      fill.classList.toggle("is-indeterminate", active && !known);
      card.querySelector(".local-transfer-numbers").textContent = total || loaded
        ? `${bytes(loaded)} / ${total ? bytes(total) : "tamanho desconhecido"} · ${speed > 0 ? bytes(speed) + "/s" : "Aguardando dados"}` : "";
      card.querySelector(".local-progress-message").textContent = message;
    } };
  }
  async function copyFiles(body, title) {
    const view = progressCard(title); copyList.append(view.card);
    let latest = { phase: "copying", percent: null, loaded: 0, total: 0, speed: 0 };
    let changedAt = Date.now();
    const paint = () => {
      const idle = (Date.now() - changedAt) / 1000;
      const waiting = latest.phase === "confirming";
      const done = latest.phase === "done";
      const failed = latest.phase === "error";
      view.update({ ...latest, percent: waiting ? null : latest.percent,
        phase: failed ? "Copia interrompida" : done ? "Recebido no PC" : waiting ? "Confirmando recebimento" : "Copiando para o PC",
        speed: idle > 3 ? 0 : latest.speed,
        active: !done && !failed && (waiting || idle < 10), failed,
        message: failed ? "O auxiliar nao confirmou o recebimento. Tente enviar novamente."
          : done ? "Copia confirmada. O processamento continua no auxiliar."
          : waiting ? "Dados enviados. Aguardando o auxiliar confirmar a gravacao."
          : idle >= 10 ? `Sem novos dados ha ${Math.floor(idle)}s. Verifique o auxiliar; nao ha progresso confirmado nesse periodo.`
          : "Transferindo dados. Aguarde a confirmacao antes de fechar a pagina." });
    };
    paint();
    const timer = window.setInterval(paint, 1000);
    try {
      await window.MegaRoomLocalTransfer.copyToHelper({ url: base + "/jobs", key, body, onProgress(progress) {
        if (progress.loaded !== latest.loaded || progress.phase !== latest.phase) changedAt = Date.now();
        latest = progress; paint();
      } });
    } catch (error) {
      latest = { ...latest, phase: "error" }; paint();
      view.card.querySelector(".local-progress-message").textContent = error.message;
      const dismiss = document.createElement("button"); dismiss.className = "mini-btn"; dismiss.textContent = "Apagar aviso de falha";
      dismiss.addEventListener("click", () => view.card.remove()); view.card.append(dismiss);
      throw error;
    } finally {
      window.clearInterval(timer);
      while (copyList.children.length > 5) copyList.firstElementChild.remove();
    }
  }
  input.value = key;
  const say = (text) => { message.textContent = text; panel.open = true; };
  async function request(route, options = {}) {
    const response = await fetch(base + route, { ...options, targetAddressSpace: "loopback", headers: { "X-Local-Key": key, ...options.headers } });
    if (!response.ok) {
      if (response.status === 401) throw new Error("Codigo do auxiliar incorreto. Copie o codigo exibido na janela dele.");
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Auxiliar respondeu ${response.status}.`);
    }
    return response.json();
  }
  async function connect() {
    if (!window.isSecureContext) throw new Error("Abra o site por HTTPS para permitir acesso ao auxiliar local. Em desenvolvimento, use localhost.");
    key = input.value.trim();
    if (!key) throw new Error("Instale e abra o auxiliar. Depois cole aqui o codigo mostrado por ele.");
    let health;
    try { health = await request("/health"); }
    catch (error) {
      if (error instanceof TypeError) throw new Error("Auxiliar nao encontrado. Execute o instalador, mantenha a janela aberta e permita o acesso a rede local no navegador.");
      throw error;
    }
    if (!health.ffmpeg) throw new Error("FFmpeg nao instalado no auxiliar. Execute novamente o instalador para instalar o FFmpeg incluido.");
    canDelete = health.features?.includes("delete-failed") || false;
    if (health.features?.includes("resource-profiles")) {
      try { renderSettings(await request("/settings")); }
      catch (error) { resourceSelect.disabled = true; resourceMessage.textContent = error.message; }
    } else {
      resourceSelect.disabled = true;
      resourceMessage.textContent = "Atualize o auxiliar pelo instalador para liberar perfis de CPU e apagar falhas. Aguarde o processamento atual terminar antes de fecha-lo.";
    }
    connected = true; localStorage.setItem("megaaroom-local-key", key);
    say("PC conectado. FFmpeg pronto para processar.");
    poll();
  }
  panel.querySelector(".local-connect").addEventListener("click", () => connect().catch((error) => say(error.message)));
  async function poll() {
    if (polling || !connected) return;
    window.clearTimeout(pollTimer);
    polling = true;
    try {
      const jobs = await request("/jobs");
      const visible = new Set(jobs.slice(-20).map((job) => job.id));
      for (const [id, view] of jobCards) {
        if (!visible.has(id)) { view.card.remove(); jobCards.delete(id); transferSamples.delete(id); }
      }
      for (const job of jobs.slice(-20).reverse()) {
        let view = jobCards.get(job.id);
        if (!view) { view = progressCard(job.title); jobCards.set(job.id, view); jobsList.append(view.card); }
        const uploading = job.status === "uploading";
        const now = Date.now();
        const previous = transferSamples.get(job.id);
        const changed = !previous || job.loaded !== previous.loaded;
        const changedAt = changed ? now : previous.changedAt;
        const measuredSpeed = previous && now > previous.at && job.loaded >= previous.loaded
          ? (job.loaded - previous.loaded) / ((now - previous.at) / 1000) : 0;
        transferSamples.set(job.id, { at: now, loaded: job.loaded, changedAt });
        const stale = now - (job.lastTransferAt || changedAt) > 10000;
        const processing = ["processing", "preparing"].includes(job.processing?.status);
        view.update({ phase: uploading ? "Enviando para a VPS" : job.status === "done" ? "Concluido" : job.status === "error" ? "Falha" : job.status === "queued" ? "Na fila do PC" : "Processando no PC",
          percent: uploading || job.status === "done" ? job.percent : processing ? job.processing.percent : null,
          loaded: uploading ? job.loaded : 0, total: uploading ? job.total : 0,
          speed: stale ? 0 : job.speedBytesPerSecond ?? measuredSpeed,
          active: ["processing", "uploading"].includes(job.status) && !stale, failed: job.status === "error",
          message: stale && uploading ? "Sem novos dados de envio. Aguardando a conexao com a VPS." : processing ? job.processing.message : job.message });
        const previousActions = view.card.querySelector(".local-job-actions");
        if (job.status !== "error") previousActions?.remove();
        if (job.status === "error" && !previousActions) {
          const actions = document.createElement("div"); actions.className = "local-job-actions";
          const retry = document.createElement("button"); retry.className = "mini-btn"; retry.textContent = "Tentar novamente";
          const remove = document.createElement("button"); remove.className = "mini-btn local-delete-job"; remove.textContent = "Apagar falha";
          remove.disabled = !canDelete;
          remove.title = canDelete ? "Remove o trabalho e suas copias temporarias no PC." : "Atualize o auxiliar pelo instalador.";
          retry.addEventListener("click", async () => {
            actions.dataset.busy = "true";
            retry.disabled = remove.disabled = true;
            try { await request(`/jobs/${job.id}/retry`, { method: "POST" }); poll(); }
            catch (error) { say(error.message); }
            finally { actions.dataset.busy = "false"; retry.disabled = false; remove.disabled = !canDelete; }
          });
          remove.addEventListener("click", async () => {
            actions.dataset.busy = "true";
            retry.disabled = remove.disabled = true;
            try {
              await request(`/jobs/${job.id}/delete`, { method: "POST" });
              view.card.remove(); jobCards.delete(job.id); transferSamples.delete(job.id);
              say("Falha apagada e arquivos temporarios removidos do PC.");
            } catch (error) { say(error.message); }
            finally { actions.dataset.busy = "false"; retry.disabled = false; remove.disabled = !canDelete; }
          });
          actions.append(retry, remove); view.card.append(actions);
        }
        if (previousActions) previousActions.querySelector(".local-delete-job").disabled = !canDelete || previousActions.dataset.busy === "true";
      }
      // Update the catalogue without reloading the player.
      const completed = jobs.filter((job) => job.status === "done").map((job) => job.id).join(",");
      if (completed !== lastCompleted && typeof loadLibrary === "function") {
        lastCompleted = completed; await loadLibrary(true, { syncRoute: false });
      }
    } catch (error) {
      say(error.message); connected = false;
      for (const view of jobCards.values()) {
        if (view.card.dataset.active !== "true") continue;
        view.card.dataset.active = "false";
        view.card.querySelector(".progress-fill").classList.remove("is-indeterminate");
        view.card.querySelector(".local-progress-message").textContent = "Sem conexao com o auxiliar. Reconecte para confirmar o progresso.";
      }
    }
    finally {
      polling = false;
      if (connected) pollTimer = window.setTimeout(() => { if (!document.hidden) poll(); }, 3000);
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  for (const form of document.querySelectorAll("#movieForm, #seriesForm")) {
    const field = document.createElement("label");
    field.innerHTML = `<span>Onde otimizar</span><select name="processingLocation"><option value="server">Na VPS</option><option value="local">Neste computador</option></select>`;
    form.querySelector(".processing-check").after(field);
    const location = field.querySelector("select");
    location.addEventListener("change", () => {
      if (location.value === "local") {
        form.elements.processVideo.checked = true;
        form.dispatchEvent(new Event("change"));
        panel.open = true;
      }
    });
    form.addEventListener("submit", async (event) => {
      if (!form.elements.processVideo.checked || location.value !== "local") return;
      event.preventDefault(); event.stopImmediatePropagation();
      const button = form.querySelector('[type="submit"]'); button.disabled = true;
      try {
        await connect();
        const kind = form.id === "movieForm" ? "movie" : "series";
        const files = [...(kind === "movie" ? form.elements.videos.files : form.elements.episodes.files)];
        if (kind === "series") files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
        const qualities = [...form.querySelectorAll('[name="quality"]:checked')].map((choice) => Number(choice.value));
        if (!files.length || !qualities.length) throw new Error("Selecione arquivos e ao menos uma qualidade.");
        // One movie per ticket; a season remains a single catalogue item.
        const groups = kind === "movie" ? files.map((file) => [file]) : [files];
        for (const group of groups) {
          const meta = { kind, count: group.length, qualities,
            title: kind === "movie" && files.length > 1 ? "" : form.elements.title.value,
            genre: form.elements.genre.value, year: form.elements.year.value,
            synopsis: form.elements.synopsis.value, seasonNumber: form.elements.seasonNumber?.value || 1 };
          const response = await fetch("/api/local-import/ticket", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) });
          if (!response.ok) throw new Error("Nao foi possivel autorizar o envio para a VPS.");
          meta.ticket = await response.json();
          const body = new FormData(); body.append("metadata", JSON.stringify(meta));
          for (const file of group) body.append("videos", file);
          if (form.elements.cover.files[0]) body.append("cover", form.elements.cover.files[0]);
          say("Copiando arquivo para o auxiliar no PC. Aguarde antes de fechar esta pagina.");
          await copyFiles(body, meta.title || group[0].name);
        }
        form.reset();
        say("Arquivos recebidos no PC. O auxiliar continuara processando e enviando mesmo com F5. Mantenha o PC ligado e a janela do auxiliar aberta.");
      } catch (error) { say(error.message); }
      finally { button.disabled = false; }
    }, true);
  }
  if (key && window.isSecureContext) connect().catch(() => {});
})();
