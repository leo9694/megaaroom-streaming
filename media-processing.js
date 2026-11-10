const os = require("os");
const { AsyncLocalStorage } = require("node:async_hooks");
const policyContext = new AsyncLocalStorage();

const available = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const requested = Number(process.env.MEDIA_THREADS);
const threads = Number.isInteger(requested) && requested > 0
  ? Math.min(requested, 4, available)
  : Math.max(1, Math.min(2, Math.floor(available / 2)));

function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

function getMediaPolicy() {
  return policyContext.getStore()?.() || { threads, filterThreads: 1, priority: os.constants.priority.PRIORITY_BELOW_NORMAL };
}

function withMediaPolicy(getPolicy, task) {
  return policyContext.run(getPolicy, task);
}

function localProfiles(cpuCount = available) {
  const count = Math.max(1, cpuCount);
  return [
    { id: "economy", label: "Economico", threads: Math.max(1, Math.min(2, Math.ceil(count / 4))), filterThreads: 1, priority: os.constants.priority.PRIORITY_BELOW_NORMAL },
    { id: "balanced", label: "Equilibrado", threads: Math.max(1, Math.ceil(count / 2)), filterThreads: Math.max(1, Math.min(4, Math.ceil(count / 4))), priority: os.constants.priority.PRIORITY_BELOW_NORMAL },
    { id: "fast", label: "Rapido", threads: Math.max(1, Math.ceil(count * 0.75)), filterThreads: Math.max(1, Math.min(8, Math.ceil(count / 2))), priority: os.constants.priority.PRIORITY_NORMAL },
    { id: "maximum", label: "Maximo", threads: count, filterThreads: Math.min(8, count), priority: os.constants.priority.PRIORITY_NORMAL }
  ];
}

function limitFfmpegArgs(args, policy = getMediaPolicy()) {
  // Decoder and encoder limits have separate input/output scopes.
  const limited = ["-nostdin", "-filter_threads", String(policy.filterThreads), "-filter_complex_threads", String(policy.filterThreads)];
  for (const arg of args.slice(0, -1)) {
    if (arg === "-i") limited.push("-threads", String(policy.threads));
    limited.push(arg);
  }
  limited.push("-threads", String(policy.threads), args[args.length - 1]);
  return limited;
}

function lowerPriority(proc, policy = getMediaPolicy()) {
  if (!proc.pid) return;
  try {
    os.setPriority(proc.pid, policy.priority);
  } catch {
    // Limits still apply on hosts that disallow priority changes.
  }
}

module.exports = { createSerialQueue, limitFfmpegArgs, lowerPriority, threads, getMediaPolicy, withMediaPolicy, localProfiles };
