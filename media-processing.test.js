const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createSerialQueue, limitFfmpegArgs, threads } = require("./media-processing");
const exec = promisify(execFile);

test("only one task runs and failures do not block the queue", async () => {
  const enqueue = createSerialQueue();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const first = enqueue(async () => {
    events.push("first");
    await gate;
    throw new Error("expected");
  });
  const rejected = assert.rejects(first, /expected/);
  const second = enqueue(() => events.push("second"));
  await Promise.resolve();
  assert.deepEqual(events, ["first"]);
  release();
  await Promise.all([rejected, second]);
  assert.deepEqual(events, ["first", "second"]);
});

test("thread limits cover input decoding and output encoding", () => {
  const args = limitFfmpegArgs(["-y", "-i", "movie.mkv", "-c:v", "libx264", "out.mp4"]);
  assert.equal(args[args.indexOf("-i") - 1], String(threads));
  assert.deepEqual(args.slice(-3), ["-threads", String(threads), "out.mp4"]);
  assert.ok(threads >= 1 && threads <= 4);
});

test("bundled FFmpeg accepts the lighter H264/AAC settings and FPS cap", async () => {
  for (const rate of [24, 60]) {
    const { stderr } = await exec(require("ffmpeg-static"), limitFfmpegArgs([
      "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=${rate}:duration=1`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-vf", "fps=fps='min(source_fps,30)',scale=320:180",
      "-c:v", "libx264", "-preset", "superfast", "-crf", "23",
      "-maxrate", "1250k", "-bufsize", "1800k",
      "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "3.0",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-f", "null", "-"
    ]), { windowsHide: true });
    assert.match(stderr, /Video: h264/);
    assert.match(stderr, /Audio: aac/);
    assert.match(stderr, new RegExp(`${Math.min(rate, 30)} fps`));
  }
});
