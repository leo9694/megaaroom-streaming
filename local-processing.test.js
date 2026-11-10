const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { artifactPath } = require("./local-import");
const { mergeMasters } = require("./existing-local");

test("adding a local quality keeps old segments and uses immutable paths for new segments", () => {
  const previous = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\n480p/index.m3u8\n';
  const incoming = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/stream-1/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\n720p/index.m3u8\n';
  const merged = mergeMasters(previous, incoming, "movie_123_test", "local-batch");
  assert.match(merged, /\/streams\/movie_123_test\/hls\/480p\/index.m3u8/);
  assert.match(merged, /\/streams\/movie_123_test\/local-batch\/hls\/720p\/index.m3u8/);
  assert.match(merged, /URI="\/streams\/movie_123_test\/local-batch\/hls\/audio\/stream-1\/index.m3u8"/);
  assert.throws(() => mergeMasters("", incoming.replace("720p/index.m3u8", "../720p/index.m3u8"), "movie_123_test", "batch"));
});

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
  const downloads = [];
  try {
    vps = spawn(process.execPath, ["-e", 'const app=require("./server").app; const s=app.listen(0,"127.0.0.1",()=>process.send(s.address().port)); s.requestTimeout=0; s.on("request",req=>{const url=req.originalUrl||req.url;if(url.endsWith("/source"))process.send({source:url})});'], {
      cwd: __dirname, env: { ...process.env, MEGAROOM_MEDIA_ROOT: remote, APP_USERNAME: "test", APP_PASSWORD: "secret" },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true
    });
    vps.stdout.on("data", (data) => logs.push(String(data)));
    vps.stderr.on("data", (data) => logs.push(String(data)));
    const port = await new Promise((resolve, reject) => {
      vps.once("message", resolve); vps.once("error", reject); vps.once("exit", (code) => reject(new Error("VPS exited " + code + logs.join(""))));
    });
    const origin = `http://127.0.0.1:${port}`;
    vps.on("message", (message) => { if (message.source) downloads.push(message.source); });
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
    await promisify(execFile)(require("ffmpeg-static"), ["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=2",
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
    assert.equal((await fetch(origin + original.source, { method: "HEAD", headers: credentials })).status, 200);
    assert.ok(library.items[0].video.src.includes(`/uploads/${library.items[0].folder}/originals/`), "Imported source must include staging folder");
    assert.equal((await fetch(origin + "/uploads/missing-file.mp4", { method: "HEAD", headers: credentials })).status, 404);
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
    // Simulate a catalogue written by the old importer and an unoptimized upload.
    const libraryPath = path.join(remote, "data", "library.json");
    const stored = JSON.parse(await fs.readFile(libraryPath, "utf8"));
    const film = stored.items.find((item) => item.id === entryId);
    const correctSource = film.video.src;
    film.video.src = "/uploads/originals/" + path.basename(correctSource);
    film.localAnalysis.requiresPreparedStream = false;
    const unoptimized = JSON.parse(JSON.stringify(film));
    unoptimized.id = "movie_1234_unoptimized";
    unoptimized.processing = { enabled: false, qualities: [] };
    delete unoptimized.localImportId;
    stored.items.push(unoptimized);
    await fs.writeFile(libraryPath, JSON.stringify(stored));
    const repaired = await (await fetch(origin + `/api/playback/${entryId}`, { headers: credentials })).json();
    assert.equal(repaired.fallbackSource, correctSource);
    assert.equal((await fetch(origin + repaired.fallbackSource, { method: "HEAD", headers: credentials })).status, 200);
    const oldFiles = await fs.stat(path.join(remote, "streams", entryId, "hls", "480p", "index.m3u8"));
    await fetch(origin + `/api/progress/${entryId}`, { method: "POST", headers: { ...credentials, "Content-Type": "application/json" }, body: JSON.stringify({ position: 0.5, duration: 2 }) });
    async function reoptimize(targetId, quality) {
      const authorization = await fetch(origin + `/api/media/${targetId}/local-ticket`, { method: "POST", headers: { ...credentials, "Content-Type": "application/json" }, body: JSON.stringify({ qualities: [quality] }) });
      assert.equal(authorization.status, 200);
      const remoteTicket = await authorization.json();
      assert.equal((await fetch(origin + `/api/media/${targetId}/optimize`, { method: "POST", headers: { ...credentials, "Content-Type": "application/json" }, body: JSON.stringify({ qualities: [quality] }) })).status, 409);
      const submittedRemote = await fetch(base + "/jobs/from-server", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ ticket: remoteTicket, profile: "economy" }) });
      assert.equal(submittedRemote.status, 202, await submittedRemote.text());
      let current;
      for (let i = 0; i < 200; i++) {
        const active = await (await fetch(base + "/jobs", { headers })).json();
        current = active.find((job) => !["done"].includes(job.status));
        if (!current) return;
        assert.notEqual(current.status, "error", current.message);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("Reoptimization did not complete");
    }
    await reoptimize(entryId, 720);
    const upgraded = await (await fetch(origin + `/api/playback/${entryId}`, { headers: credentials })).json();
    assert.deepEqual(upgraded.qualities, [720, 480]);
    const masterText = await (await fetch(origin + upgraded.source, { headers: credentials })).text();
    const mediaUris = masterText.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
    for (const uri of mediaUris) assert.equal((await fetch(origin + uri, { headers: credentials })).status, 200);
    assert.equal((await fs.stat(path.join(remote, "streams", entryId, "hls", "480p", "index.m3u8"))).mtimeMs, oldFiles.mtimeMs);
    const progress = await (await fetch(origin + "/api/progress", { headers: credentials })).json();
    assert.equal(progress[entryId].position, 0.5);
    await reoptimize(unoptimized.id, 480);
    const newlyOptimized = await (await fetch(origin + `/api/playback/${unoptimized.id}`, { headers: credentials })).json();
    assert.equal(newlyOptimized.playbackType, "hls");
    const finalCatalogue = await (await fetch(origin + "/api/library", { headers: credentials })).json();
    assert.equal(finalCatalogue.items.length, 3, "Reoptimization must not create duplicate movies");
    assert.equal(finalCatalogue.items.find((item) => item.id === entryId).video.src, correctSource);
    // Scramble storage order: both server tickets and the PC must sort numerically.
    const savedSeason = JSON.parse(await fs.readFile(libraryPath, "utf8"));
    savedSeason.items.find((item) => item.id === season.id).episodes.reverse();
    await fs.writeFile(libraryPath, JSON.stringify(savedSeason));
    const seasonAuthorization = await fetch(origin + `/api/series/${season.id}/local-tickets`, { method: "POST", headers: { ...credentials, "Content-Type": "application/json" }, body: JSON.stringify({ qualities: [720] }) });
    assert.equal(seasonAuthorization.status, 200);
    const seasonBatch = await seasonAuthorization.json();
    assert.deepEqual(seasonBatch.tickets.map((ticket) => ticket.episodeNumber), [1, 2]);
    downloads.length = 0;
    const orderedSubmission = await fetch(base + "/jobs/from-season", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ tickets: [...seasonBatch.tickets].reverse(), profile: "economy" }) });
    assert.equal(orderedSubmission.status, 202, await orderedSubmission.text());
    for (let i = 0; i < 250; i++) {
      const active = await (await fetch(base + "/jobs", { headers })).json();
      const pending = active.find((job) => job.status !== "done");
      if (!pending) break;
      assert.notEqual(pending.status, "error", pending.message);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(downloads, seasonBatch.tickets.map((ticket) => `/api/local-import/transfer/existing/${ticket.id}/source`));
    for (const episode of season.episodes) {
      const ready = await (await fetch(origin + `/api/playback/${episode.id}`, { headers: credentials })).json();
      assert.deepEqual(ready.qualities, [720, 480]);
    }
    const completedSeason = await (await fetch(origin + `/api/series/${season.id}/local-tickets`, { method: "POST", headers: { ...credentials, "Content-Type": "application/json" }, body: JSON.stringify({ qualities: [720] }) })).json();
    assert.equal(completedSeason.ready, true);
    assert.deepEqual(completedSeason.tickets, []);
    for (const episode of season.episodes) {
      await fetch(origin + `/api/progress/${episode.id}`, { method: "POST", headers: { ...credentials, "Content-Type": "application/json" }, body: JSON.stringify({ position: 0.5, duration: 2 }) });
    }
    const deletion = await fetch(origin + `/api/media/${season.id}`, { method: "DELETE", headers: credentials });
    assert.equal(deletion.status, 204, await deletion.text());
    await assert.rejects(fs.stat(path.join(remote, "uploads", season.folder)), { code: "ENOENT" });
    for (const episode of season.episodes) await assert.rejects(fs.stat(path.join(remote, "streams", episode.id)), { code: "ENOENT" });
    const afterDeletion = await (await fetch(origin + "/api/library", { headers: credentials })).json();
    assert.equal(afterDeletion.items.length, 2);
    assert.equal(afterDeletion.items.some((item) => item.id === season.id), false);
    const remainingProgress = await (await fetch(origin + "/api/progress", { headers: credentials })).json();
    for (const episode of season.episodes) assert.equal(remainingProgress[episode.id], undefined);
    const oldTicket = seasonBatch.tickets[0];
    assert.equal((await fetch(origin + `/api/local-import/transfer/existing/${oldTicket.id}/source`, { headers: { "X-Import-Token": oldTicket.token } })).status, 404);
    assert.equal((await fetch(origin + original.source, { method: "HEAD", headers: credentials })).status, 200, "Unrelated original must remain playable");
    assert.ok(!logs.some((line) => line.includes("[HLS] inicio")), "VPS must not encode existing local jobs either");
    assert.equal((await fs.readdir(path.join(pc, "uploads"))).length, 0, "Completed local input must be cleaned");
  } finally {
    if (previousRoot === undefined) delete process.env.MEGAROOM_MEDIA_ROOT; else process.env.MEGAROOM_MEDIA_ROOT = previousRoot;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (helper) { helper.closeAllConnections(); await new Promise((resolve) => helper.close(resolve)); }
    if (vps && vps.exitCode === null) { const exited = new Promise((resolve) => vps.once("exit", resolve)); vps.kill(); await exited; }
    await fs.rm(temp, { recursive: true, force: true });
  }
});
