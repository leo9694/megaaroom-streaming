const state = {
  library: [],
  filter: "all",
  uploads: [],
  search: "",
  currentView: "home",
  currentMediaId: null,
  currentEpisodeId: null,
  currentAudioIndex: 0,
  playbackPollToken: 0
};

const statusMessage = document.getElementById("statusMessage");
const movieForm = document.getElementById("movieForm");
const seriesForm = document.getElementById("seriesForm");
const uploadList = document.getElementById("uploadList");
const activeUploadsBadge = document.getElementById("activeUploadsBadge");
const emptyStateTemplate = document.getElementById("emptyStateTemplate");
const searchInput = document.getElementById("searchInput");
const homeView = document.getElementById("homeView");
const detailView = document.getElementById("detailView");
const featuredGrid = document.getElementById("featuredGrid");
const recentGrid = document.getElementById("recentGrid");
const movieGrid = document.getElementById("movieGrid");
const seriesGrid = document.getElementById("seriesGrid");
const brandButton = document.getElementById("brandButton");
const heroArt = document.getElementById("heroArt");
const heroTitle = document.getElementById("heroTitle");
const heroText = document.getElementById("heroText");
const heroPlayButton = document.getElementById("heroPlayButton");
const heroScrollButton = document.getElementById("heroScrollButton");
const detailHero = document.getElementById("detailHero");
const detailBadge = document.getElementById("detailBadge");
const detailTitle = document.getElementById("detailTitle");
const detailMeta = document.getElementById("detailMeta");
const detailSynopsis = document.getElementById("detailSynopsis");
const detailPlayer = document.getElementById("detailPlayer");
const playbackStatus = document.getElementById("playbackStatus");
const audioSelector = document.getElementById("audioSelector");
const changeCoverButton = document.getElementById("changeCoverButton");
const coverFileInput = document.getElementById("coverFileInput");
const detailPanelTitle = document.getElementById("detailPanelTitle");
const episodePanel = document.getElementById("episodePanel");
const relatedList = document.getElementById("relatedList");
const backButton = document.getElementById("backButton");

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("is-active"));
    document.querySelectorAll(".upload-form").forEach((form) => form.classList.add("hidden"));
    button.classList.add("is-active");
    document.getElementById(button.dataset.target).classList.remove("hidden");
    setStatus("");
  });
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((filter) => filter.classList.remove("is-active"));
    button.classList.add("is-active");
    state.filter = button.dataset.filter;
    renderHome();
  });
});

document.querySelectorAll(".nav-link").forEach((button) => {
  button.addEventListener("click", () => {
    activateNav(button.dataset.nav);
    showHome();
    if (button.dataset.nav === "recent") {
      recentGrid.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (button.dataset.nav === "movie" || button.dataset.nav === "series") {
      state.filter = button.dataset.nav;
      document.querySelectorAll(".filter").forEach((filter) => {
        filter.classList.toggle("is-active", filter.dataset.filter === state.filter);
      });
      renderHome();
    } else {
      state.filter = "all";
      document.querySelectorAll(".filter").forEach((filter) => {
        filter.classList.toggle("is-active", filter.dataset.filter === "all");
      });
      document.getElementById("catalogAnchor").scrollIntoView({ behavior: "smooth", block: "start" });
      renderHome();
    }
  });
});

brandButton.addEventListener("click", () => {
  activateNav("home");
  navigateToHome();
});

heroScrollButton.addEventListener("click", () => {
  document.getElementById("catalogAnchor").scrollIntoView({ behavior: "smooth", block: "start" });
});

heroPlayButton.addEventListener("click", () => {
  const first = getFilteredLibrary()[0];
  if (first) {
    openMedia(first.id);
  }
});

backButton.addEventListener("click", () => {
  navigateToHome();
});

changeCoverButton.addEventListener("click", () => {
  if (state.currentMediaId) {
    coverFileInput.click();
  }
});

coverFileInput.addEventListener("change", async () => {
  const file = coverFileInput.files?.[0];
  if (!file || !state.currentMediaId) {
    return;
  }

  const formData = new FormData();
  formData.append("cover", file);

  try {
    const response = await fetch(`/api/media/${state.currentMediaId}/cover`, {
      method: "POST",
      body: formData
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Nao foi possivel salvar a capa.");
    }

    setStatus("Capa atualizada.");
    await loadLibrary(true);
    const item = state.library.find((entry) => entry.id === state.currentMediaId);
    if (item) {
      renderDetail(item);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    coverFileInput.value = "";
  }
});

searchInput.addEventListener("input", () => {
  state.search = searchInput.value.trim().toLowerCase();
  renderHome();
});

window.addEventListener("popstate", () => {
  syncRoute();
});

movieForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const files = Array.from(form.elements.videos.files || []);
  const coverFile = form.elements.cover.files?.[0] || null;

  if (!files.length) {
    setStatus("Selecione ao menos um filme.", true);
    return;
  }

  const sharedTitle = (form.elements.title.value || "").trim();
  const sharedFields = {
    genre: form.elements.genre.value,
    year: form.elements.year.value,
    synopsis: form.elements.synopsis.value
  };

  files.forEach((file) => {
    const formData = new FormData();
    formData.append("video", file);
    if (coverFile) {
      formData.append("cover", coverFile);
    }
    formData.append("genre", sharedFields.genre);
    formData.append("year", sharedFields.year);
    formData.append("synopsis", sharedFields.synopsis);
    formData.append("title", files.length === 1 && sharedTitle ? sharedTitle : "");

    startTrackedUpload({
      kind: "movie",
      title: files.length === 1 && sharedTitle ? sharedTitle : cleanName(file.name),
      url: "/api/upload/movie",
      formData
    });
  });

  form.reset();
  setStatus(`${files.length} upload(s) iniciado(s).`);
});

seriesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const episodes = Array.from(form.elements.episodes.files || []);
  const title = (form.elements.title.value || "").trim();
  const coverFile = form.elements.cover.files?.[0] || null;

  if (!episodes.length) {
    setStatus("Selecione os episodios da temporada.", true);
    return;
  }

  if (!title) {
    setStatus("Informe o titulo da serie.", true);
    return;
  }

  const formData = new FormData();
  formData.append("title", title);
  if (coverFile) {
    formData.append("cover", coverFile);
  }
  formData.append("genre", form.elements.genre.value);
  formData.append("year", form.elements.year.value);
  formData.append("synopsis", form.elements.synopsis.value);
  formData.append("seasonNumber", form.elements.seasonNumber.value);
  episodes.forEach((file) => formData.append("episodes", file));

  startTrackedUpload({
    kind: "series",
    title: `${title} - Temporada ${form.elements.seasonNumber.value || 1}`,
    subtitle: `${episodes.length} episodios`,
    url: "/api/upload/series",
    formData
  });

  form.reset();
  setStatus("Upload da temporada iniciado.");
});

async function loadLibrary(silent = false) {
  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    const data = await response.json();
    state.library = data.items || [];
    updateStats();
    syncRoute();
  } catch {
    if (!silent) {
      setStatus("Nao foi possivel carregar a biblioteca.", true);
    }
  }
}

function syncRoute() {
  const path = window.location.pathname;
  const match = path.match(/^\/media\/([^/]+)$/);
  if (match) {
    const shouldPreserveScroll = state.currentMediaId === match[1] && state.currentView === "detail";
    openMedia(match[1], true, shouldPreserveScroll);
    return;
  }
  showHome();
}

function showHome() {
  state.currentView = "home";
  state.currentMediaId = null;
  homeView.classList.remove("hidden");
  detailView.classList.add("hidden");
  renderHome();
}

function navigateToHome() {
  history.pushState({}, "", "/");
  showHome();
}

function openMedia(id, fromRoute = false, preserveScroll = false) {
  const item = state.library.find((entry) => entry.id === id);
  if (!item) {
    navigateToHome();
    return;
  }

  if (!fromRoute) {
    history.pushState({}, "", `/media/${id}`);
  }

  state.currentView = "detail";
  state.currentMediaId = id;
  state.currentEpisodeId = item.type === "series" ? item.episodes[0]?.id || null : null;
  state.currentAudioIndex = 0;
  homeView.classList.add("hidden");
  detailView.classList.remove("hidden");
  renderDetail(item);
  if (!preserveScroll) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function renderHome() {
  const allItems = getFilteredLibrary();
  const featured = allItems.slice(0, 3);
  const recents = [...allItems].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12);
  const movies = allItems.filter((item) => item.type === "movie");
  const series = allItems.filter((item) => item.type === "series");
  const heroItem = allItems[0];

  renderHero(heroItem);
  renderGrid(featuredGrid, featured, "featured");
  renderGrid(recentGrid, recents, "poster");
  renderGrid(movieGrid, movies, "poster");
  renderGrid(seriesGrid, series, "poster");
}

function renderHero(item) {
  if (!item) {
    heroArt.style.background = buildBackdrop(0, "Biblioteca pessoal");
    heroArt.style.backgroundSize = "";
    heroArt.style.backgroundPosition = "";
    heroTitle.textContent = "Seu streaming particular, organizado como um catalogo de verdade.";
    heroText.textContent = "Suba filmes, temporadas completas, acompanhe uploads em paralelo e assista em qualquer maquina apontando para sua VPS.";
    heroPlayButton.disabled = true;
    return;
  }

  heroArt.style.background = buildBackdrop(0, item.title, item.cover?.src);
  heroArt.style.backgroundSize = item.cover?.src ? "cover" : "";
  heroArt.style.backgroundPosition = item.cover?.src ? "center" : "";
  heroTitle.textContent = item.title;
  heroText.textContent = item.synopsis || "Sem sinopse cadastrada.";
  heroPlayButton.disabled = false;
  heroPlayButton.onclick = () => openMedia(item.id);
}

function renderGrid(container, items, mode) {
  container.innerHTML = "";
  if (!items.length) {
    container.appendChild(emptyStateTemplate.content.cloneNode(true));
    return;
  }

  items.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = mode === "featured" ? "featured-card" : "poster-card";
    card.style.background = buildBackdrop(index, item.title, item.cover?.src);
    card.style.backgroundSize = item.cover?.src ? "cover" : "";
    card.style.backgroundPosition = item.cover?.src ? "center" : "";
    card.innerHTML = mode === "featured" ? buildFeaturedCardMarkup(item) : buildPosterCardMarkup(item);
    bindCardActions(card, item);
    container.appendChild(card);
  });
}

function bindCardActions(card, item) {
  card.querySelectorAll("[data-action='open']").forEach((button) => {
    button.addEventListener("click", () => openMedia(item.id));
  });

  const deleteButton = card.querySelector("[data-action='delete']");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => deleteMedia(item.id));
  }
}

function buildFeaturedCardMarkup(item) {
  return `
    <div class="featured-body">
      <div class="badge-row">
        <span class="type-badge">${item.type === "movie" ? "FILME" : "SERIE"}</span>
        <span class="meta-badge">${item.year || "Sem ano"}</span>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(truncate(item.synopsis || "Sem sinopse cadastrada.", 125))}</p>
      <div class="featured-footer">
        <button class="hero-primary" data-action="open" type="button">Assistir</button>
        <button class="delete-btn" data-action="delete" type="button">Apagar</button>
      </div>
    </div>
  `;
}

function buildPosterCardMarkup(item) {
  return `
    <div class="poster-body">
      <div class="badge-row">
        <span class="type-badge">${item.type === "movie" ? "FILME" : "SERIE"}</span>
        <span class="meta-badge">${item.genre || "Catalogo"}</span>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <div class="poster-meta">
        <span>${escapeHtml(item.year || "Sem ano")}</span>
        <span>${item.type === "series" ? `${item.episodes.length} eps` : formatFileLabel(item.video?.originalName)}</span>
      </div>
      <div class="card-actions">
        <button class="mini-btn" data-action="open" type="button">Abrir</button>
        <button class="delete-btn" data-action="delete" type="button">Apagar</button>
      </div>
    </div>
  `;
}

function renderDetail(item) {
  detailHero.style.background = buildBackdrop(0, item.title, item.cover?.src);
  detailHero.style.backgroundSize = item.cover?.src ? "cover" : "";
  detailHero.style.backgroundPosition = item.cover?.src ? "center" : "";
  detailBadge.textContent = item.type === "movie" ? "Filme" : "Serie";
  detailTitle.textContent = item.title;
  detailMeta.textContent = buildMeta(item);
  detailSynopsis.textContent = item.synopsis || "Sem sinopse cadastrada.";
  audioSelector.innerHTML = "";
  hidePlaybackStatus();

  if (item.type === "movie") {
    detailPanelTitle.textContent = "Arquivo disponivel";
    episodePanel.innerHTML = `
      <button class="episode-item is-active" type="button">
        Filme completo
        <small>${escapeHtml(item.video.originalName || "Arquivo principal")}</small>
      </button>
    `;
    loadPlaybackSource(item.id);
  } else {
    detailPanelTitle.textContent = "Lista de episodios";
    const selectedEpisode = item.episodes.find((episode) => episode.id === state.currentEpisodeId) || item.episodes[0];
    state.currentEpisodeId = selectedEpisode?.id || null;
    episodePanel.innerHTML = item.episodes
      .map(
        (episode) => `
          <button class="episode-item ${episode.id === state.currentEpisodeId ? "is-active" : ""}" data-episode-id="${episode.id}" type="button">
            Episodio ${episode.episodeNumber}
            <small>${escapeHtml(episode.title)}</small>
          </button>
        `
      )
      .join("");

    episodePanel.querySelectorAll("[data-episode-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.currentEpisodeId = button.dataset.episodeId;
        renderDetail(item);
      });
    });

    if (selectedEpisode) {
      loadPlaybackSource(selectedEpisode.id);
    }
  }

  renderRelated(item);
}

async function loadPlaybackSource(entryId) {
  const token = ++state.playbackPollToken;

  try {
    const response = await fetch(`/api/playback/${entryId}?audio=${state.currentAudioIndex}`, { cache: "no-store" });
    const payload = await response.json();

    if (token !== state.playbackPollToken) {
      return;
    }

    renderAudioSelector(entryId, payload.audioTracks || []);

    if (payload.status === "ready") {
      hidePlaybackStatus();
      const absoluteSrc = new URL(payload.source, window.location.origin).href;
      if (detailPlayer.src !== absoluteSrc) {
        detailPlayer.src = payload.source;
      }
      return;
    }

    const prep = (payload.preparation || []).find((entry) => entry.audioIndex === state.currentAudioIndex);
    const statusText = prep
      ? `${prep.message}${typeof prep.percent === "number" ? ` (${prep.percent}%)` : ""}`
      : payload.message || "Preparando versão compatível para reprodução...";
    showPlaybackStatus(statusText);
    window.setTimeout(() => {
      if (token === state.playbackPollToken) {
        loadPlaybackSource(entryId);
      }
    }, 2500);
  } catch {
    if (token !== state.playbackPollToken) {
      return;
    }
    showPlaybackStatus("Falha ao preparar a reprodução.");
  }
}

function renderAudioSelector(entryId, audioTracks) {
  if (!audioTracks.length) {
    audioSelector.innerHTML = "";
    return;
  }

  audioSelector.innerHTML = audioTracks
    .map(
      (track) => `
        <button class="audio-btn ${track.index === state.currentAudioIndex ? "is-active" : ""}" data-audio-index="${track.index}" type="button">
          ${escapeHtml(track.language || `Faixa ${track.index + 1}`)}
        </button>
      `
    )
    .join("");

  audioSelector.querySelectorAll("[data-audio-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.currentAudioIndex = Number(button.dataset.audioIndex);
      loadPlaybackSource(entryId);
    });
  });
}

function showPlaybackStatus(message) {
  playbackStatus.textContent = message;
  playbackStatus.classList.remove("hidden");
}

function hidePlaybackStatus() {
  playbackStatus.textContent = "";
  playbackStatus.classList.add("hidden");
}

function renderRelated(item) {
  const related = getFilteredLibrary()
    .filter((entry) => entry.id !== item.id)
    .slice(0, 6);

  if (!related.length) {
    relatedList.innerHTML = `<div class="upload-empty"><strong>Sem sugestoes</strong><span>Adicione mais conteudo para ver recomendacoes aqui.</span></div>`;
    return;
  }

  relatedList.innerHTML = related
    .map(
      (entry, index) => `
        <button class="related-item" data-related-id="${entry.id}" type="button">
          <div class="related-thumb" style="${buildThumbStyle(entry, index)}"></div>
          <div class="related-copy">
            <strong>${escapeHtml(entry.title)}</strong>
            <p>${escapeHtml(entry.year || entry.genre || "Catalogo")}</p>
          </div>
        </button>
      `
    )
    .join("");

  relatedList.querySelectorAll("[data-related-id]").forEach((button) => {
    button.addEventListener("click", () => openMedia(button.dataset.relatedId));
  });
}

async function deleteMedia(id) {
  const item = state.library.find((entry) => entry.id === id);
  if (!item) {
    return;
  }

  if (!window.confirm(`Deseja apagar "${item.title}" do catalogo?`)) {
    return;
  }

  try {
    const response = await fetch(`/api/media/${id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 204) {
      throw new Error(payload.error || "Nao foi possivel apagar a midia.");
    }

    setStatus(payload.error || "Midia removida.");
    await loadLibrary(true);

    if (state.currentMediaId === id) {
      navigateToHome();
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

function startTrackedUpload({ kind, title, subtitle = "", url, formData }) {
  const upload = {
    id: crypto.randomUUID ? crypto.randomUUID() : `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    title,
    subtitle,
    percent: 0,
    uploadedBytes: 0,
    totalBytes: calculateFormDataUploadSize(formData),
    speedBytesPerSecond: 0,
    status: "uploading",
    message: "Conectando...",
    indeterminate: true,
    estimated: true,
    createdAt: Date.now()
  };

  state.uploads.unshift(upload);
  renderUploadList();
  const pollHandle = startServerUploadPolling(upload.id);

  let sawRealProgress = false;
  const fallbackTicker = window.setInterval(() => {
    const current = state.uploads.find((entry) => entry.id === upload.id);
    if (!current || current.status !== "uploading" || sawRealProgress) {
      return;
    }

    const nextPercent = current.percent < 5 ? 5 : Math.min(current.percent + 2, 15);
    updateUpload(upload.id, {
      percent: nextPercent,
      status: "uploading",
      indeterminate: true,
      estimated: true,
      message: nextPercent < 10 ? "Conectando..." : "Aguardando progresso real do envio..."
    });
  }, 1200);

  sendUploadRequest(
    `${url}?uploadId=${encodeURIComponent(upload.id)}`,
    formData,
    (percent, meta = {}) => {
      if (meta.real) {
        sawRealProgress = true;
      }

      updateUpload(upload.id, {
        percent,
        uploadedBytes: typeof meta.loaded === "number" ? meta.loaded : upload.uploadedBytes,
        totalBytes: typeof meta.total === "number" && meta.total > 0 ? meta.total : upload.totalBytes,
        speedBytesPerSecond: typeof meta.speed === "number" ? meta.speed : upload.speedBytesPerSecond,
        status: "uploading",
        indeterminate: !meta.real,
        estimated: !meta.real,
        message: percent >= 100 ? "Processando..." : meta.real ? "Enviando..." : "Conectando..."
      });
    },
    async (result) => {
      window.clearInterval(fallbackTicker);
      window.clearInterval(pollHandle);
      if (result.ok) {
        updateUpload(upload.id, {
          percent: 100,
          uploadedBytes: upload.totalBytes || upload.uploadedBytes,
          speedBytesPerSecond: 0,
          status: "done",
          message: "Upload concluido.",
          indeterminate: false,
          estimated: false
        });
        setStatus(`Upload concluido: ${title}`);
        await loadLibrary(true);
        cleanupUploadLater(upload.id);
      } else {
        updateUpload(upload.id, {
          percent: Math.max(upload.percent, 1),
          speedBytesPerSecond: 0,
          status: "error",
          message: result.error || "Falha no upload.",
          indeterminate: false,
          estimated: false
        });
        setStatus(result.error || `Falha ao enviar ${title}.`, true);
      }
    }
  );
}

function startServerUploadPolling(uploadId) {
  return window.setInterval(async () => {
    const current = state.uploads.find((entry) => entry.id === uploadId);
    if (!current || current.status !== "uploading") {
      return;
    }

    try {
      const response = await fetch(`/api/uploads/status/${uploadId}`, { cache: "no-store" });
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      const serverPercent = typeof payload.percent === "number" ? payload.percent : current.percent;
      const inferredUploadedBytes = current.totalBytes
        ? Math.min(current.totalBytes, Math.round((serverPercent / 100) * current.totalBytes))
        : current.uploadedBytes;

      updateUpload(uploadId, {
        percent: Math.max(current.percent, serverPercent),
        uploadedBytes: Math.max(current.uploadedBytes, inferredUploadedBytes),
        status: payload.status === "processing" ? "uploading" : current.status,
        indeterminate: payload.status === "processing",
        estimated: false,
        message:
          payload.status === "processing"
            ? "Processando no servidor..."
            : payload.status === "completed"
              ? "Upload concluido."
              : "Enviando..."
      });
    } catch {
      // Silencioso: o upload principal continua pelo XHR
    }
  }, 900);
}

function renderUploadList() {
  const uploads = [...state.uploads].sort((a, b) => b.createdAt - a.createdAt);
  const activeCount = uploads.filter((item) => item.status === "uploading").length;
  activeUploadsBadge.textContent = `${activeCount} ativo${activeCount === 1 ? "" : "s"}`;

  if (!uploads.length) {
    uploadList.innerHTML = `
      <div class="upload-empty">
        <strong>Nenhum upload em andamento.</strong>
        <span>Os novos envios vao aparecer aqui com progresso individual.</span>
      </div>
    `;
    return;
  }

  uploadList.innerHTML = uploads
    .map(
      (upload) => `
        <article class="upload-item upload-${upload.status}">
          <div class="upload-item-head">
            <div>
              <strong>${escapeHtml(upload.title)}</strong>
              <p>${escapeHtml(upload.subtitle || (upload.kind === "movie" ? "Filme" : "Serie"))}</p>
            </div>
            <span>${upload.estimated && upload.status === "uploading" ? "~" : ""}${upload.percent}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill ${upload.indeterminate ? "is-indeterminate" : ""}" style="width:${upload.percent}%"></div>
          </div>
          <div class="upload-transfer-meta">
            <span>${formatUploadedAmount(upload)}</span>
            <span>${formatUploadSpeed(upload)}</span>
          </div>
          <div class="upload-item-meta">
            <span>${upload.message}</span>
            <span>${uploadStatusLabel(upload.status)}</span>
          </div>
        </article>
      `
    )
    .join("");
}

function updateUpload(id, nextFields) {
  const upload = state.uploads.find((entry) => entry.id === id);
  if (!upload) {
    return;
  }
  Object.assign(upload, nextFields);
  renderUploadList();
}

function cleanupUploadLater(id) {
  setTimeout(() => {
    state.uploads = state.uploads.filter((entry) => entry.id !== id);
    renderUploadList();
  }, 4500);
}

function sendUploadRequest(url, formData, onProgress, onComplete) {
  const request = new XMLHttpRequest();
  request.open("POST", url, true);
  request.responseType = "json";
  let startedAt = Date.now();

  onProgress(1, { real: false, phase: "queued", total: calculateFormDataUploadSize(formData) });

  request.upload.addEventListener("loadstart", () => {
    startedAt = Date.now();
    onProgress(1, { real: false, phase: "loadstart", total: calculateFormDataUploadSize(formData) });
  });

  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) {
      return;
    }
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const speed = event.loaded / elapsedSeconds;
    onProgress(Math.max(1, Math.min(100, Math.round((event.loaded / event.total) * 100))), {
      real: true,
      phase: "upload",
      loaded: event.loaded,
      total: event.total,
      speed
    });
  });

  request.addEventListener("load", () => {
    onProgress(100, {
      real: true,
      phase: "complete",
      loaded: calculateFormDataUploadSize(formData),
      total: calculateFormDataUploadSize(formData),
      speed: 0
    });
    const payload = request.response || parseJsonSafely(request.responseText) || {};
    if (request.status >= 200 && request.status < 300) {
      onComplete({ ok: true, data: payload });
      return;
    }
    onComplete({ ok: false, error: payload.error || "Falha ao enviar a midia." });
  });

  request.addEventListener("error", () => {
    onComplete({ ok: false, error: "Erro de rede durante o upload." });
  });

  request.send(formData);
}

function getFilteredLibrary() {
  return state.library.filter((item) => {
    const byType = state.filter === "all" || item.type === state.filter;
    const haystack = `${item.title} ${item.genre} ${item.year} ${item.synopsis}`.toLowerCase();
    const bySearch = !state.search || haystack.includes(state.search);
    return byType && bySearch;
  });
}

function buildMeta(item) {
  if (item.type === "movie") {
    return [item.genre, item.year, formatFileLabel(item.video?.originalName)].filter(Boolean).join(" • ");
  }
  return [item.genre, item.year, `Temporada ${item.seasonNumber || 1}`, `${item.episodes.length} episodios`]
    .filter(Boolean)
    .join(" • ");
}

function updateStats() {
  const movies = state.library.filter((item) => item.type === "movie").length;
  const series = state.library.filter((item) => item.type === "series").length;
  const episodes = state.library.reduce((count, item) => count + (item.episodes ? item.episodes.length : 0), 0);

  document.getElementById("movieCount").textContent = movies;
  document.getElementById("seriesCount").textContent = series;
  document.getElementById("episodeCount").textContent = episodes;
}

function buildBackdrop(index, title, coverSrc = "") {
  const gradient = buildPosterGradient(index, title);
  if (coverSrc) {
    return `linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.88)), url("${coverSrc}"), ${gradient}`;
  }
  return `linear-gradient(180deg, rgba(0,0,0,0.10), rgba(0,0,0,0.84)), ${gradient}`;
}

function buildPosterGradient(index, title) {
  const palettes = [
    ["#5a1919", "#173742", "#2d3137"],
    ["#73410d", "#14363f", "#2b2d31"],
    ["#18394b", "#41161d", "#272a31"],
    ["#5b2217", "#1f3940", "#2b3035"],
    ["#7d4410", "#1b2638", "#2a2f33"]
  ];
  const seed = (title || "").length + index;
  const [a, b, c] = palettes[seed % palettes.length];
  return `linear-gradient(145deg, ${a}, ${b} 55%, ${c})`;
}

function buildThumbStyle(item, index) {
  if (item.cover?.src) {
    return `background-image:url("${item.cover.src}");background-size:cover;background-position:center;`;
  }
  return `background:${buildPosterGradient(index, item.title)};`;
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#ff9ba1" : "";
}

function activateNav(nav) {
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.nav === nav);
  });
}

function parseJsonSafely(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || "";
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function cleanName(name) {
  return (name || "").replace(/\.[^.]+$/, "").replace(/[._-]+/g, " ").trim() || "Midia";
}

function formatFileLabel(name) {
  if (!name) {
    return "VIDEO";
  }
  const extension = name.split(".").pop();
  return extension ? extension.toUpperCase() : name;
}

function calculateFormDataUploadSize(formData) {
  let total = 0;
  for (const [, value] of formData.entries()) {
    if (value instanceof File) {
      total += value.size;
      continue;
    }
    total += new Blob([String(value)]).size;
  }
  return total;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatUploadSpeed(upload) {
  if (upload.status === "done") {
    return "Finalizado";
  }
  if (upload.status === "error") {
    return "Falhou";
  }
  if (!upload.speedBytesPerSecond || upload.estimated) {
    return "Velocidade: aguardando...";
  }
  return `${formatBytes(upload.speedBytesPerSecond)}/s`;
}

function formatUploadedAmount(upload) {
  const uploaded = upload.status === "done" ? upload.totalBytes || upload.uploadedBytes : upload.uploadedBytes;
  const total = upload.totalBytes;
  if (!total) {
    return `${formatBytes(uploaded)} enviados`;
  }
  return `${formatBytes(uploaded)} / ${formatBytes(total)}`;
}

function uploadStatusLabel(status) {
  if (status === "done") {
    return "Concluido";
  }
  if (status === "error") {
    return "Erro";
  }
  return "Enviando";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

renderUploadList();
loadLibrary();
setInterval(() => {
  loadLibrary(true);
}, 15000);
