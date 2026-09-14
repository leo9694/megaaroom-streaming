const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

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
