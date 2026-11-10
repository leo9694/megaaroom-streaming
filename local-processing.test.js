const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { artifactPath } = require("./local-import");

test("import rejects traversal and remote asset references", () => {
  assert.throws(() => artifactPath("asset-0:../../server.js", 1));
  assert.throws(() => artifactPath("asset-1:hls/master.m3u8", 1));
  assert.deepEqual(artifactPath("asset-0:hls/480p/index.m3u8", 1), { index: 0, relative: "hls/480p/index.m3u8" });
});

test("PC converts real video, uploads to authenticated VPS and publishes ready media", { timeout: 60000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "megaaroom-local-e2e-"));
  const pc = path.join(temp, "pc");
  const remote = path.join(temp, "vps");
  let vps, helper;
  const previousRoot = process.env.MEGAROOM_MEDIA_ROOT;
  const previousMode = process.env.NODE_ENV;
  const logs = [];
  try {
    vps = spawn(process.execPath, ["-e", 'const app=require("./server").app; const s=app.listen(0,"127.0.0.1",()=>process.send(s.address().port)); s.requestTimeout=0;'], {
      cwd: __dirname, env: { ...process.env, MEGAROOM_MEDIA_ROOT: remote, APP_USERNAME: "test", APP_PASSWORD: "secret" },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true
    });
    vps.stdout.on("data", (data) => logs.push(String(data)));
    vps.stderr.on("data", (data) => logs.push(String(data)));
    const port = await new Promise((resolve, reject) => {
      vps.once("message", resolve); vps.once("error", reject); vps.once("exit", (code) => reject(new Error("VPS exited " + code + logs.join(""))));
    });
    const origin = `http://127.0.0.1:${port}`;
    const credentials = { Authorization: "Basic " + Buffer.from("test:secret").toString("base64") };
    const ticketResponse = await fetch(origin + "/api/local-import/ticket", { method: "POST", headers: { ...credentials, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "movie", count: 1, title: "PC fixture", qualities: [480] }) });
    assert.equal(ticketResponse.status, 200);
    const ticket = await ticketResponse.json();
    assert.equal((await fetch(origin + `/api/local-import/transfer/${ticket.id}`, { method: "POST" })).status, 403);

    await fs.mkdir(pc, { recursive: true });
    const subtitle = path.join(pc, "source.srt");
    await fs.writeFile(subtitle, "1\n00:00:00,000 --> 00:00:01,500\nTeste local\n");
    const movie = path.join(pc, "source.mkv");
    await promisify(execFile)(require("ffmpeg-static"), ["-y", "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=24:duration=2",
      "-f", "lavfi", "-i", "sine=duration=2", "-i", subtitle, "-map", "0:v", "-map", "1:a", "-map", "2:s",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "srt",
      "-metadata:s:a:0", "language=por", "-metadata:s:s:0", "language=por", movie], { windowsHide: true });
    process.env.MEGAROOM_MEDIA_ROOT = pc;
    process.env.NODE_ENV = "test";
    const engine = require("./server");
    const { createHelper } = require("./local-helper");
    const local = await createHelper({ origin, root: pc, key: "test-key", engine });
    helper = local.listen(0, "127.0.0.1");
    await new Promise((resolve) => helper.once("listening", resolve));
    const base = `http://127.0.0.1:${helper.address().port}`;
    const headers = { Origin: origin, "X-Local-Key": "test-key" };
    assert.equal((await fetch(base + "/health", { headers: { ...headers, Origin: "https://attacker.invalid" } })).status, 403);
    assert.equal((await fetch(base + "/health", { headers: { Origin: origin } })).status, 401);
    assert.equal((await (await fetch(base + "/health", { headers })).json()).ffmpeg, true);
    const body = new FormData();
    body.append("metadata", JSON.stringify({ kind: "movie", title: "PC fixture", qualities: [480], ticket }));
    body.append("videos", new Blob([await fs.readFile(movie)], { type: "video/x-matroska" }), "fixture.mkv");
    const submitted = await fetch(base + "/jobs", { method: "POST", headers, body });
    assert.equal(submitted.status, 202, await submitted.text());
    let job;
    for (let i = 0; i < 150; i++) {
      [job] = await (await fetch(base + "/jobs", { headers })).json();
      if (["done", "error"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, "done", job.message + "\n" + logs.join(""));
    const library = await (await fetch(origin + "/api/library", { headers: credentials })).json();
    assert.equal(library.items.length, 1);
    const entryId = library.items[0].id;
    const playback = await (await fetch(origin + `/api/playback/${entryId}`, { headers: credentials })).json();
    assert.equal(playback.playbackType, "hls");
    assert.deepEqual(playback.qualities, [480]);
    assert.equal(playback.subtitleTracks[0].status, "ready");
    assert.equal((await fetch(origin + playback.source, { headers: credentials })).status, 200);
    const original = await (await fetch(origin + `/api/playback/${entryId}?original=1`, { headers: credentials })).json();
    assert.equal(original.status, "ready");
    assert.match(original.source, /original-audio/);
    assert.ok(!logs.some((line) => line.includes("[HLS] inicio")), "VPS must not encode video");
    const repeated = await fetch(origin + `/api/local-import/transfer/${ticket.id}`, { method: "POST", headers: { "X-Import-Token": ticket.token } });
    assert.equal(repeated.status, 200);
    assert.equal((await (await fetch(origin + "/api/library", { headers: credentials })).json()).items.length, 1, "Retry must not publish duplicates");

    const seasonTicket = await (await fetch(origin + "/api/local-import/ticket", { method: "POST", headers: { ...credentials, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "series", count: 2, title: "Local season", seasonNumber: 2, qualities: [480] }) })).json();
    const seasonBody = new FormData();
    seasonBody.append("metadata", JSON.stringify({ kind: "series", title: "Local season", seasonNumber: 2, qualities: [480], ticket: seasonTicket }));
    const bytes = await fs.readFile(movie);
    for (const name of ["S02E01.mkv", "S02E02.mkv"]) seasonBody.append("videos", new Blob([bytes], { type: "video/x-matroska" }), name);
    assert.equal((await fetch(base + "/jobs", { method: "POST", headers, body: seasonBody })).status, 202);
    let seasonJob;
    for (let i = 0; i < 150; i++) {
      seasonJob = (await (await fetch(base + "/jobs", { headers })).json()).find((entry) => entry.title === "Local season");
      if (["done", "error"].includes(seasonJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(seasonJob.status, "done", seasonJob.message);
    const updated = await (await fetch(origin + "/api/library", { headers: credentials })).json();
    const season = updated.items.find((item) => item.type === "series");
    assert.equal(season.seasonNumber, 2);
    assert.equal(season.episodes.length, 2);
    for (const episode of season.episodes) {
      const ready = await (await fetch(origin + `/api/playback/${episode.id}`, { headers: credentials })).json();
      assert.equal(ready.playbackType, "hls");
      assert.equal(ready.subtitleTracks[0].status, "ready");
    }
    assert.equal((await fs.readdir(path.join(pc, "uploads"))).length, 0, "Completed local input must be cleaned");
  } finally {
    if (previousRoot === undefined) delete process.env.MEGAROOM_MEDIA_ROOT; else process.env.MEGAROOM_MEDIA_ROOT = previousRoot;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (helper) { helper.closeAllConnections(); await new Promise((resolve) => helper.close(resolve)); }
    if (vps && vps.exitCode === null) { const exited = new Promise((resolve) => vps.once("exit", resolve)); vps.kill(); await exited; }
    await fs.rm(temp, { recursive: true, force: true });
  }
});
