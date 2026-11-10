const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { cleanupMediaFiles } = require("./media-cleanup");

test("season cleanup removes every episode, partial output and ticket, preserving unrelated media", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "megaaroom-cleanup-"));
  try {
    const item = { id: "series_test", folder: "season_upload", uploadFolders: ["later_upload"], episodes: [{ id: "episode_1" }, { id: "episode_2", folder: "episode_upload" }] };
    const deleted = ["uploads/season_upload/originals", "uploads/later_upload", "uploads/episode_upload", "streams/series_test", "streams/episode_1/hls", "streams/episode_2/.hls-tmp", "streams/episode_2/local-batch"];
    for (const folder of [...deleted, "streams/movie_other/hls"]) {
      await fs.mkdir(path.join(root, folder), { recursive: true });
      await fs.writeFile(path.join(root, folder, "fixture"), "data");
    }
    const tickets = path.join(root, "data", "existing-tickets"); await fs.mkdir(tickets, { recursive: true });
    const removedTicket = path.join(tickets, "a".repeat(48) + ".json");
    const keptTicket = path.join(tickets, "b".repeat(48) + ".json");
    await fs.writeFile(removedTicket, JSON.stringify({ entryId: "episode_2" }));
    await fs.writeFile(keptTicket, JSON.stringify({ entryId: "movie_other" }));
    await cleanupMediaFiles(root, item, async (folder) => { await fs.rm(folder, { recursive: true, force: true }); return true; });
    for (const folder of deleted) await assert.rejects(fs.stat(path.join(root, folder)), { code: "ENOENT" });
    await assert.rejects(fs.stat(removedTicket), { code: "ENOENT" });
    assert.equal((await fs.stat(path.join(root, "streams/movie_other/hls/fixture"))).isFile(), true);
    assert.equal((await fs.stat(keptTicket)).isFile(), true);
    await assert.rejects(cleanupMediaFiles(root, { id: "../unsafe" }, async () => true), /invalido/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("movie deletion removes cover, original, audio, subtitles and optimized versions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "megaaroom-movie-cleanup-"));
  try {
    const files = ["uploads/movie_source/movie.mkv", "uploads/movie_source/cover.jpg",
      "streams/movie_test/audio-stream-1.mp4", "streams/movie_test/subtitles/subtitle-1.vtt",
      "streams/movie_test/hls/480p/segment.m4s", "streams/movie_test/audio-stream-2.mp4.tmp.mp4"];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), "fixture");
    }
    await cleanupMediaFiles(root, { id: "movie_test", folder: "movie_source" }, async (folder) => {
      await fs.rm(folder, { recursive: true, force: true }); return true;
    });
    for (const file of files) await assert.rejects(fs.stat(path.join(root, file)), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
