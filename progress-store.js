const fs = require('node:fs/promises');

module.exports = function createProgressStore(file) {
  let queue = Promise.resolve();
  async function read() {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  return {
    async all() { await queue; return read(); },
    save(id, input) {
      const job = queue.then(async () => {
        const data = await read();
        const previous = data[id] || {};
        const position = input.position;
        const duration = input.duration;
        if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration < 0) {
          throw new Error('INVALID_PROGRESS');
        }
        data[id] = {
          position: duration > 0 ? Math.min(position, duration) : position,
          duration,
          watched: previous.watched === true || input.watched === true,
          updatedAt: Date.now()
        };
        await fs.writeFile(`${file}.tmp`, JSON.stringify(data));
        await fs.rename(`${file}.tmp`, file);
        return data[id];
      });
      queue = job.catch(() => {});
      return job;
    }
  };
};
