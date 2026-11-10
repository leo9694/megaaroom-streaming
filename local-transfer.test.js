const test = require("node:test");
const assert = require("node:assert/strict");
const { copyToHelper } = require("./public/local-transfer");
const { selectJobs } = require("./public/local-transfer");
const { createEtaEstimator, formatEta } = require("./public/local-transfer");

test("ETA estimates remaining time from actual progress and resets between phases", () => {
  let time = 0;
  const estimator = createEtaEstimator({ now: () => time });
  const sample = (completed, phaseKey = "video", total = 100) => estimator.update({ phaseKey, completed, total });
  assert.equal(sample(20).status, "calculating");
  time = 3000;
  assert.equal(sample(23).status, "calculating");
  time = 5000;
  assert.equal(sample(25).seconds, 75);
  assert.match(formatEta(sample(25), "o processamento"), /2 minutos/);
  time = 10000;
  assert.ok(sample(35).seconds < 75, "ETA should respond to faster observed processing");
  assert.equal(sample(0, "upload", 1000).status, "calculating", "Conversion speed must not be reused for upload");
  time = 15000;
  assert.equal(sample(500, "upload", 1000).seconds, 5);
  assert.match(formatEta(sample(500, "upload", 1000), "o envio"), /menos de 1 minuto/);
  time = 31000;
  assert.equal(sample(500, "upload", 1000).status, "waiting");
  time = 32000;
  assert.equal(sample(1000, "upload", 1000).status, "finishing");
  assert.equal(sample(0, "upload", 1000).status, "calculating", "Retries reset the estimate");
});

test("ETA handles unknown totals, idle resume and coarse processing progress", () => {
  let time = 0;
  const estimator = createEtaEstimator({ now: () => time });
  assert.equal(estimator.update({ phaseKey: "video", completed: undefined, total: 100 }).status, "calculating");
  estimator.update({ phaseKey: "video", completed: 34, total: 100, processing: true });
  time = 60000;
  const result = estimator.update({ phaseKey: "video", completed: 35, total: 100, processing: true });
  assert.equal(result.seconds, 3900);
  assert.match(formatEta(result, "o processamento"), /1 hora e 5 minutos/);
  time = 400000;
  assert.equal(estimator.update({ phaseKey: "video", completed: 45, total: 100, processing: true }).status, "calculating");
});

test("completed jobs only appear after opening history, while failures remain visible", () => {
  const jobs = [{ id: "done", status: "done" }, { id: "failed", status: "error" }, { id: "active", status: "processing" }];
  assert.deepEqual(selectJobs(jobs, false).jobs.map((job) => job.id), ["active", "failed"]);
  assert.equal(selectJobs(jobs, false).completedCount, 1);
  assert.deepEqual(selectJobs(jobs, true).jobs.map((job) => job.id), ["active", "failed", "done"]);
});

class Events {
  constructor() { this.listeners = {}; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  emit(name, event = {}) { this.listeners[name]?.(event); }
}
class FakeRequest extends Events {
  constructor() { super(); this.upload = new Events(); FakeRequest.last = this; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.header = [name, value]; }
  send(body) { this.body = body; }
}

test("copy progress follows real bytes and waits for helper confirmation", async () => {
  let at = 0;
  const updates = [];
  let done = false;
  const promise = copyToHelper({ url: "http://127.0.0.1:43123/jobs", key: "secret", body: "data",
    XMLHttpRequestImpl: FakeRequest, now: () => at, onProgress: (progress) => updates.push(progress)
  }).then((result) => { done = true; return result; });
  const xhr = FakeRequest.last;
  assert.deepEqual(xhr.header, ["X-Local-Key", "secret"]);
  assert.equal(updates.at(-1).percent, null);
  at = 1000;
  xhr.upload.emit("progress", { loaded: 250, total: 1000, lengthComputable: true });
  assert.equal(updates.at(-1).percent, 25);
  assert.equal(updates.at(-1).speed, 250);
  at = 2000;
  xhr.upload.emit("progress", { loaded: 1000, total: 1000, lengthComputable: true });
  xhr.upload.emit("load");
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(updates.at(-1).phase, "confirming");
  xhr.status = 202; xhr.responseText = '{"id":"job"}'; xhr.emit("load");
  assert.deepEqual(await promise, { id: "job" });
  assert.equal(updates.at(-1).phase, "done");
});

test("unknown totals stay indeterminate and network failure is not success", async () => {
  const updates = [];
  const promise = copyToHelper({ url: "/jobs", key: "key", body: "data", XMLHttpRequestImpl: FakeRequest,
    onProgress: (progress) => updates.push(progress) });
  FakeRequest.last.upload.emit("progress", { loaded: 300, lengthComputable: false });
  assert.equal(updates.at(-1).loaded, 300);
  assert.equal(updates.at(-1).percent, null);
  FakeRequest.last.emit("error");
  await assert.rejects(promise, /interrompida/);
  assert.equal(updates.at(-1).phase, "error");
});

test("server rejection after full upload does not show confirmed receipt", async () => {
  const updates = [];
  const promise = copyToHelper({ url: "/jobs", key: "key", body: "data", XMLHttpRequestImpl: FakeRequest,
    onProgress: (progress) => updates.push(progress) });
  const xhr = FakeRequest.last;
  xhr.upload.emit("load");
  xhr.status = 503; xhr.responseText = '{"error":"FFmpeg indisponivel"}'; xhr.emit("load");
  await assert.rejects(promise, /FFmpeg indisponivel/);
  assert.equal(updates.at(-1).phase, "error");
});
