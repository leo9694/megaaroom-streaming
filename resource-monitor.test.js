const test = require("node:test");
const assert = require("node:assert/strict");
const { createResourceMonitor } = require("./resource-monitor");

test("machine usage uses measured CPU deltas, reports RAM and caches repeated polls", () => {
  let time = 0;
  let user = 0;
  let idle = 0;
  let reads = 0;
  const system = {
    cpus() { reads++; return [{ times: { user, idle, sys: 0, nice: 0, irq: 0 } }, { times: { user, idle, sys: 0, nice: 0, irq: 0 } }]; },
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 4 * 1024 ** 3
  };
  const monitor = createResourceMonitor({ system, now: () => time });
  const initial = monitor.sample();
  assert.equal(initial.cpuPercent, null, "Do not show fake zero before first CPU interval");
  assert.equal(initial.memoryUsedBytes, 12 * 1024 ** 3);
  assert.equal(initial.memoryPercent, 75);
  user = 250; idle = 750; time = 1000;
  const measured = monitor.sample();
  assert.equal(measured.cpuPercent, 25);
  assert.equal(measured.scope, "machine");
  const readCount = reads;
  time = 1100;
  assert.equal(monitor.sample(), measured);
  assert.equal(reads, readCount, "Repeated requests must not resample all CPUs");
  user = 1250; time = 2000;
  assert.equal(monitor.sample().cpuPercent, 100);
});

test("CPU counter reset or missing CPUs never produce a misleading percentage", () => {
  let time = 0;
  let cpus = [{ times: { idle: 500, user: 500 } }];
  const monitor = createResourceMonitor({ now: () => time, system: { cpus: () => cpus, freemem: () => 100, totalmem: () => 100 } });
  cpus = []; time = 1000;
  assert.equal(monitor.sample().cpuPercent, null);
  cpus = [{ times: { idle: 0, user: 0 } }]; time = 2000;
  assert.equal(monitor.sample().cpuPercent, null);
});
