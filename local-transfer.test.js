const test = require("node:test");
const assert = require("node:assert/strict");
const { copyToHelper } = require("./public/local-transfer");

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
