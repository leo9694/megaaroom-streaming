const os = require("node:os");

function createResourceMonitor({ system = os, now = Date.now, interval = 1000 } = {}) {
  const cpuTimes = () => system.cpus().map(({ times }) => ({ idle: times.idle, total: Object.values(times).reduce((sum, time) => sum + time, 0) }));
  let previous = cpuTimes();
  let previousAt = now();
  let cached;
  let sampledAt = -Infinity;
  return {
    sample() {
      const at = now();
      if (cached && at - sampledAt < interval) return cached;
      let cpuPercent = null;
      if (at - previousAt >= interval) {
        const current = cpuTimes();
        if (current.length && current.length === previous.length) {
          const total = current.reduce((sum, cpu, i) => sum + cpu.total - previous[i].total, 0);
          const idle = current.reduce((sum, cpu, i) => sum + cpu.idle - previous[i].idle, 0);
          if (total > 0 && idle >= 0) cpuPercent = Math.max(0, Math.min(100, (1 - idle / total) * 100));
        }
        previous = current; previousAt = at;
      }
      const memoryTotalBytes = system.totalmem();
      const memoryUsedBytes = Math.max(0, Math.min(memoryTotalBytes, memoryTotalBytes - system.freemem()));
      cached = { scope: "machine", cpuPercent, memoryUsedBytes, memoryTotalBytes,
        memoryPercent: memoryTotalBytes > 0 ? memoryUsedBytes / memoryTotalBytes * 100 : null,
        sampledAt: at };
      sampledAt = at;
      return cached;
    }
  };
}

module.exports = { createResourceMonitor };
