const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHelper } = require("./local-helper");

test("local settings persist, failed deletion removes only its copies and rejects unsafe paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "megaaroom-controls-"));
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const origin = "https://tv.example.test";
  const headers = { Origin: origin, "X-Local-Key": "test", "Content-Type": "application/json" };
  let server;
  try {
    const jobsDir = path.join(root, "local-jobs");
    await fs.mkdir(jobsDir, { recursive: true });
    const failedId = "a".repeat(32);
    const doneId = "b".repeat(32);
    const unsafeId = "c".repeat(32);
    const entryId = "movie_123456_test";
    const copied = path.join(root, "uploads", failedId);
    const output = path.join(root, "streams", entryId);
    for (const folder of [copied, output]) {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "fixture"), "temporary");
    }
    const original = path.join(root, "my-original.mkv");
    await fs.writeFile(original, "original");
    const fixtures = [
      { id: failedId, status: "error", entries: [{ entryId }] },
      { id: doneId, status: "done", entries: [] },
      { id: unsafeId, status: "error", entries: [{ entryId: "../../my-original.mkv" }] }
    ];
    for (const job of fixtures) await fs.writeFile(path.join(jobsDir, job.id + ".json"), JSON.stringify(job));
    const app = await createHelper({ origin, root, key: "test", engine: {} });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await fetch(base + "/settings", { headers: { Origin: origin } })).status, 401);
    assert.equal((await post("/settings", { profile: "malicious" })).status, 400);
    const saved = await post("/settings", { profile: "maximum" });
    assert.equal(saved.status, 200);
    const settings = await saved.json();
    assert.equal(settings.profile, "maximum");
    assert.equal(settings.profiles.find((profile) => profile.id === "maximum").threads, settings.cpuCount);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "local-settings.json"), "utf8")).profile, "maximum");
    assert.equal((await post(`/jobs/${doneId}/delete`)).status, 409);
    assert.equal((await post(`/jobs/${unsafeId}/delete`)).status, 500);
    assert.equal((await fs.stat(copied)).isDirectory(), true);
    assert.equal((await post(`/jobs/${failedId}/delete`)).status, 200);
    for (const file of [copied, output, path.join(jobsDir, failedId + ".json")]) {
      await assert.rejects(fs.stat(file), { code: "ENOENT" });
    }
    assert.equal(await fs.readFile(original, "utf8"), "original");
    assert.equal((await (await fetch(base + "/jobs", { headers })).json()).some((job) => job.id === failedId), false);
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    const restarted = await createHelper({ origin, root, key: "test", engine: {} });
    server = restarted.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/settings`, { headers });
    assert.equal((await response.json()).profile, "maximum");
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  }
});
