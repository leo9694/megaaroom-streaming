const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const createStore = require('./progress-store');

test('progress survives restart, concurrent saves and watched/pause races', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'megaaroom-progress-'));
  const file = path.join(folder, 'progress.json');
  try {
    const store = createStore(file);
    assert.deepEqual(await store.all(), {});
    await Promise.all([
      store.save('episode1', { position: 45, duration: 100, watched: true }),
      store.save('episode1', { position: 46, duration: 100 }),
      store.save('episode2', { position: 20, duration: 100 })
    ]);
    const freshDevice = await createStore(file).all();
    assert.equal(freshDevice.episode1.watched, true);
    assert.equal(freshDevice.episode2.position, 20);
    await assert.rejects(store.save('episode2', { position: -1, duration: 100 }));
    await store.save('episode2', { position: 35, duration: 100 });
    assert.equal((await store.all()).episode2.position, 35);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
