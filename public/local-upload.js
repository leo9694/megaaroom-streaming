(() => {
  const base = "http://127.0.0.1:43123";
  let key = localStorage.getItem("megaaroom-local-key") || "";
  let polling = false;
  let connected = false;
  let lastCompleted = "";
  let pollTimer;
  const panel = document.createElement("details");
  panel.className = "processing-options local-helper-panel";
  panel.innerHTML = `<summary>Processamento neste computador</summary>
    <p>Instale o auxiliar uma vez. Ele inclui FFmpeg e usa o PC para preparar e enviar os videos, mesmo se recarregar esta pagina.</p>
    <p><a href="/install-local.ps1" download>Baixar instalador para Windows</a> · <a href="/local-help.html" target="_blank" rel="noopener">Como instalar</a></p>
    <label>Codigo exibido pelo auxiliar<input type="password" class="local-pairing-key" autocomplete="off" /></label>
    <button type="button" class="mini-btn local-connect">Conectar auxiliar</button>
    <p class="local-helper-message" role="status"></p><div class="local-job-list" aria-live="polite"></div>`;
  document.querySelector(".upload-card").append(panel);
  const message = panel.querySelector(".local-helper-message");
  const jobsList = panel.querySelector(".local-job-list");
  const input = panel.querySelector("input");
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
      jobsList.replaceChildren();
      for (const job of jobs.slice(-20).reverse()) {
        const card = document.createElement("article"); card.className = "upload-item";
        const title = document.createElement("strong"); title.textContent = job.title;
        const detail = document.createElement("p");
        detail.textContent = job.processing?.status === "processing"
          ? `${job.processing.message} (${job.processing.percent}%)`
          : `${job.message}${job.status === "uploading" ? ` ${job.percent}%` : ""}`;
        card.append(title, detail);
        if (job.status === "error") {
          const retry = document.createElement("button"); retry.className = "mini-btn"; retry.textContent = "Tentar novamente";
          retry.addEventListener("click", async () => {
            retry.disabled = true;
            try { await request(`/jobs/${job.id}/retry`, { method: "POST" }); }
            catch (error) { say(error.message); }
            finally { retry.disabled = false; }
          }); card.append(retry);
        }
        jobsList.append(card);
      }
      // Update the catalogue without reloading the player.
      const completed = jobs.filter((job) => job.status === "done").map((job) => job.id).join(",");
      if (completed !== lastCompleted && typeof loadLibrary === "function") {
        lastCompleted = completed; await loadLibrary(true, { syncRoute: false });
      }
    } catch (error) { say(error.message); connected = false; }
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
          await request("/jobs", { method: "POST", body });
        }
        form.reset();
        say("Arquivos recebidos no PC. O auxiliar continuara processando e enviando mesmo com F5. Mantenha o PC ligado e a janela do auxiliar aberta.");
      } catch (error) { say(error.message); }
      finally { button.disabled = false; }
    }, true);
  }
  if (key && window.isSecureContext) connect().catch(() => {});
})();
