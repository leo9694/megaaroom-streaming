const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createUploadCleanup, finishUpload } = require("./upload-cleanup");

test("failed uploads are removed, but committed and shared originals are kept", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "megaaroom-upload-cleanup-"));
  try {
    const library = { items: [] };
    const errors = [];
    const clean = createUploadCleanup({ root, readLibrary: async () => library,
      removeDirectory: async (folder) => { await fs.rm(folder, { recursive: true, force: true }); return true; },
      logger: { error: (...args) => errors.push(args) } });
    async function request(name, parseError) {
      const folder = path.join(root, "uploads", name);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "original.mkv"), "fixture");
      const req = Object.assign(new EventEmitter(), { uploadFolderName: name });
      const res = Object.assign(new EventEmitter(), {
        status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }
      });
      await clean((req, res, callback) => callback(parseError))(req, res, () => {});
      return { req, res, folder };
    }
    const rejected = await request("rejected");
    await finishUpload(async () => { rejected.res.emit("finish"); })(rejected.req, rejected.res, assert.fail);
    await assert.rejects(fs.stat(rejected.folder), { code: "ENOENT" });

    const malformed = await request("malformed", new Error("Unexpected end of form"));
    assert.equal(malformed.res.statusCode, 400);
    await assert.rejects(fs.stat(malformed.folder), { code: "ENOENT" });

    const aborted = await request("aborted");
    aborted.req.emit("aborted");
    await aborted.req.cleanupUpload();
    await assert.rejects(fs.stat(aborted.folder), { code: "ENOENT" });

    const referenced = await request("referenced");
    library.items.push({ episodes: [{ folder: "referenced" }] });
    await referenced.req.cleanupUpload();
    assert.equal((await fs.stat(referenced.folder)).isDirectory(), true);

    const committed = await request("committed");
    await finishUpload(async (req) => {
      committed.res.emit("close");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await fs.stat(committed.folder)).isDirectory(), true, "Disconnect cannot delete an upload during catalogue commit");
      req.uploadCommitted = true;
    })(committed.req, committed.res, assert.fail);
    assert.equal((await fs.stat(committed.folder)).isDirectory(), true);

    const failedCommit = await request("failed_commit");
    let caught;
    await finishUpload(async () => { throw new Error("Disk full"); })(failedCommit.req, failedCommit.res, (error) => { caught = error; });
    assert.match(caught.message, /Disk full/);
    await assert.rejects(fs.stat(failedCommit.folder), { code: "ENOENT" });

    const unsafe = Object.assign(new EventEmitter(), { uploadFolderName: "../" });
    clean((req, res, callback) => callback())(unsafe, new EventEmitter(), () => {});
    await unsafe.cleanupUpload();
    assert.equal(errors.length, 1);
    assert.equal((await fs.stat(committed.folder)).isDirectory(), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
