const test = require("node:test");
const assert = require("node:assert/strict");
const { orderedEpisodes } = require("./episode-order");

test("seasons are ordered numerically without mutating catalogue order", () => {
  const series = { episodes: [{ episodeNumber: 10 }, { episodeNumber: "2" }, { episodeNumber: 1 }] };
  assert.deepEqual(orderedEpisodes(series).map((episode) => Number(episode.episodeNumber)), [1, 2, 10]);
  assert.equal(series.episodes[0].episodeNumber, 10);
});
