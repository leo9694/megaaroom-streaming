function orderedEpisodes(series) {
  const number = (episode) => Number(episode.episodeNumber) > 0 ? Number(episode.episodeNumber) : Number.MAX_SAFE_INTEGER;
  return [...(series.episodes || [])].sort((a, b) => number(a) - number(b));
}

module.exports = { orderedEpisodes };
