const test = require("node:test");
const assert = require("node:assert/strict");
const { appendEpisodes, validateNewEpisodes } = require("./season-episodes");

test("adding a batch preserves episode IDs and refuses overlapping numbers atomically", () => {
  const season = { type: "series", episodes: [{ id: "old1", episodeNumber: 1 }, { id: "old2", episodeNumber: 2 }] };
  assert.throws(() => appendEpisodes(season, [{ id: "new" }], 2, "batch"), /ja existe/);
  assert.deepEqual(season.episodes.map((episode) => episode.id), ["old1", "old2"]);
  const added = appendEpisodes(season, [{ id: "new3" }, { id: "new4" }], 3, "batch");
  assert.deepEqual(season.episodes.map((episode) => episode.episodeNumber), [1, 2, 3, 4]);
  assert.equal(added[0].folder, "batch");
  assert.deepEqual(season.uploadFolders, ["batch"]);
  assert.throws(() => validateNewEpisodes({ ...season, deletionPending: true }, 1, 5), /disponivel/);
});
