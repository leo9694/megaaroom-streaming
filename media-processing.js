const os = require("os");

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

function limitFfmpegArgs(args) {
  // Decoder and encoder limits have separate input/output scopes.
  const limited = ["-nostdin", "-filter_threads", "1", "-filter_complex_threads", "1"];
  for (const arg of args.slice(0, -1)) {
    if (arg === "-i") limited.push("-threads", String(threads));
    limited.push(arg);
  }
  limited.push("-threads", String(threads), args[args.length - 1]);
  return limited;
}

function lowerPriority(proc) {
  if (!proc.pid) return;
  try {
    os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Limits still apply on hosts that disallow priority changes.
  }
}

module.exports = { createSerialQueue, limitFfmpegArgs, lowerPriority, threads };
