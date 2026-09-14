const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { parseProcessing } = require("./processing-options");

test("upload choices are validated and legacy media keeps all qualities", () => {
  assert.deepEqual(parseProcessing(), { enabled: true, qualities: [480, 720, 1080] });
  assert.deepEqual(parseProcessing('{"enabled":false}'), { enabled: false, qualities: [] });
  assert.deepEqual(parseProcessing({ enabled: true, qualities: [720, 720] }), { enabled: true, qualities: [720] });
  assert.throws(() => parseProcessing({ enabled: true, qualities: [] }));
  assert.throws(() => parseProcessing({ enabled: true, qualities: [2160] }));
});

test("saved settings control renditions and disabled mode only copies video", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "megaaroom-options-"));
  try {
    const source = await fs.readFile(path.join(__dirname, "server.js"), "utf8");
    const context = vm.createContext({ require, __dirname: folder, console, process, Buffer, setTimeout, clearTimeout });
    // Exercise server functions with isolated data and no listening HTTP server.
    vm.runInContext(source.slice(0, source.lastIndexOf("app.listen(PORT")), context);
    const api = vm.runInContext(`({ buildMovieItem, buildSeriesItem, findEntryById,
      getHlsRenditions, prepareVariant, prepareHls, readHlsQualities, getHlsPaths })`, context);
    const disabled = { enabled: false, qualities: [] };
    const file = { path: path.join(folder, "uploads", "fixture.mkv"), originalname: "fixture.mkv" };
    const body = { title: "Test", processing: disabled };
    const movie = api.buildMovieItem(file, body, null);
    const series = api.buildSeriesItem([file], body, null);
    // Round-trip the catalogue, as happens on restart.
    const library = JSON.parse(JSON.stringify({ items: [movie, series] }));
    const entry = api.findEntryById(library, movie.id);
    const episode = api.findEntryById(library, series.episodes[0].id);
    assert.equal(entry.parent.processing.enabled, false);
    assert.equal(episode.parent.processing.enabled, false);
    const analysis = { width: 1920, height: 1080, sourcePath: file.path, durationSeconds: 1,
      audioTracks: [{ index: 0, ffmpegStreamIndex: 1, language: "en" }] };
    assert.equal(api.getHlsRenditions(analysis, disabled).length, 0);
    assert.deepEqual(Array.from(api.getHlsRenditions(analysis, { enabled: true, qualities: [720] }), (r) => r.height), [720]);
    assert.equal(api.getHlsRenditions({ width: 1280, height: 720 }, { enabled: true, qualities: [1080] }).length, 0);

    const calls = [];
    context.capture = async (args) => { calls.push(args); await fs.writeFile(args.at(-1), "fixture"); };
    vm.runInContext("runFfmpeg = capture", context);
    await api.prepareVariant(entry, analysis, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("-c:v") + 1], "copy");
    assert.equal(calls[0][calls[0].indexOf("-c:a") + 1], "aac");
    assert.equal(await api.prepareHls(entry, analysis), null);
    assert.equal(calls.length, 1);

    const other = { ...entry, entryId: "copy-failure" };
    context.capture = async () => { throw new Error("cannot remux"); };
    vm.runInContext("runFfmpeg = capture", context);
    await assert.rejects(api.prepareVariant(other, analysis, 0), /processamento ativado/);

    context.capture = async (args) => { calls.push(args); await fs.writeFile(args.at(-1), "fixture"); };
    vm.runInContext("runFfmpeg = capture; ensureHlsDiskSpace = async () => {}", context);
    entry.parent.processing = { enabled: true, qualities: [720] };
    await api.prepareHls(entry, analysis);
    assert.deepEqual(Array.from(api.readHlsQualities(api.getHlsPaths(entry.entryId).masterPath)), [720]);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
