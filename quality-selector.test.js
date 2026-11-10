const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("new episode upload progress is visible inside its season and updates failures", () => {
  const source = fs.readFileSync(require.resolve("./public/app.js"), "utf8");
  const current = { mediaId: "seasonA", title: "Novos episodios A", kind: "series", percent: 40,
    uploadedBytes: 4 * 1024 ** 2, totalBytes: 10 * 1024 ** 2, speedBytesPerSecond: 1024 ** 2,
    status: "uploading", estimated: false, message: "Enviando...", createdAt: 1 };
  const inline = { innerHTML: "" };
  const message = {};
  const context = vm.createContext({
    state: { uploads: [current, { ...current, mediaId: "seasonB", title: "Outra temporada" }], currentMediaId: "seasonA" },
    uploadList: { innerHTML: "" }, addEpisodesUploadList: inline, activeUploadsBadge: {},
    document: { getElementById: () => message }
  });
  const formatterStart = source.indexOf("function formatBytes(");
  vm.runInContext(source.slice(formatterStart, source.indexOf("\nrenderUploadList();", formatterStart)), context);
  vm.runInContext(source.slice(source.indexOf("function renderUploadList("), source.indexOf("function updateUpload(")), context);
  context.renderUploadList();
  assert.match(inline.innerHTML, /Novos episodios A/);
  assert.doesNotMatch(inline.innerHTML, /Outra temporada/);
  assert.match(inline.innerHTML, /40%/);
  assert.match(inline.innerHTML, /4\.00 MB/);
  assert.match(inline.innerHTML, /1\.00 MB\/s/);
  current.status = "error"; current.message = "Falha <exemplo>";
  context.renderUploadList();
  assert.match(message.textContent, /Falha/);
  assert.match(inline.innerHTML, /Falha &lt;exemplo&gt;/);
  context.state.currentMediaId = "seasonB";
  context.renderUploadList();
  assert.doesNotMatch(inline.innerHTML, /Novos episodios A/);
  assert.match(inline.innerHTML, /Outra temporada/);
});

test("upload can select only 720p and catalogue refresh preserves optimization choices", () => {
  const source = fs.readFileSync(require.resolve("./public/app.js"), "utf8");
  const choices = [480, 720, 1080].map((value) => ({ value: String(value), name: "quality", checked: false, setCustomValidity() {} }));
  const fieldset = { disabled: true };
  const form = { elements: { processVideo: { checked: false } },
    querySelector: () => fieldset,
    querySelectorAll: (selector) => selector.includes(":checked") ? choices.filter((choice) => choice.checked) : choices };
  const context = vm.createContext({ FormData });
  const start = source.indexOf("function syncProcessingOptions(");
  vm.runInContext(source.slice(start, source.indexOf("for (const form of [movieForm", start)), context);
  context.syncProcessingOptions(form);
  assert.equal(fieldset.disabled, false);
  choices[1].checked = true;
  context.syncProcessingOptions(form, choices[1]);
  assert.equal(form.elements.processVideo.checked, true);
  const data = new FormData();
  context.appendProcessingOptions(data, form);
  assert.deepEqual(JSON.parse(data.get("processing")), { enabled: true, qualities: [720] });

  const optimizeForm = { dataset: { entryId: "movie" }, querySelectorAll: () => choices, querySelector: () => ({}) };
  context.optimizeForm = optimizeForm;
  context.optimizeMessage = {};
  context.pendingOptimizations = new Set();
  context.document = { getElementById: () => ({ classList: { toggle() {} }, addEventListener() {} }) };
  const helperStart = source.indexOf("function updateOptimizationTarget(");
  vm.runInContext(source.slice(helperStart, source.indexOf('optimizeForm.addEventListener("submit"', helperStart)), context);
  context.updateOptimizationTarget({ type: "movie", id: "movie", processing: { enabled: true, qualities: [480, 720, 1080] } });
  assert.deepEqual(choices.map((choice) => choice.checked), [false, true, false]);
  context.updateOptimizationTarget({ type: "movie", id: "other" });
  assert.equal(choices.every((choice) => !choice.checked), true);
});

test("Original is selected immediately and repeated renders preserve its button", () => {
  const source = fs.readFileSync(require.resolve("./public/app.js"), "utf8");
  const code = source.slice(source.indexOf("function renderQualitySelector("), source.indexOf("function getQualityLabelHeight("));
  let renders = 0;
  let html = "";
  const callbacks = {};
  const menu = {
    get innerHTML() { return html; },
    set innerHTML(value) { renders++; html = value; },
    classList: { add() {} },
    querySelectorAll() {
      return ["original", "auto", "480"].map((quality) => ({
        dataset: { quality, levelIndex: "0" },
        addEventListener(_event, handler) { callbacks[quality] = handler; }
      }));
    }
  };
  let loaded;
  let saved;
  const context = vm.createContext({
    state: { qualityMode: "auto", playbackType: "hls", hlsEntryId: "movie", currentHlsHeight: 480 },
    qualityToggle: {}, qualityLabel: {}, qualityMenu: menu,
    rememberPlaybackPosition(id) { saved = id; },
    loadPlaybackSource(id) { loaded = id; },
    showPlaybackStatus() {}, scheduleControlsHide() {}
  });
  vm.runInContext(code, context);
  const qualities = [{ height: 480, levelIndex: 0 }];
  context.renderQualitySelector(qualities);
  context.renderQualitySelector(qualities);
  assert.equal(renders, 1);
  callbacks.original();
  assert.equal(context.state.qualityMode, "original");
  assert.equal(context.qualityLabel.textContent, "Original");
  assert.match(html, /is-active[^>]*data-quality="original"/);
  assert.equal(loaded, "movie");
  assert.equal(saved, "movie");
});
