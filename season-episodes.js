const { orderedEpisodes } = require("./episode-order");

function validateNewEpisodes(season, count, start) {
  if (!season || season.type !== "series" || season.deletionPending) throw new Error("Temporada nao disponivel.");
  if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(start) || start < 1 || start + count > 100001) throw new Error("Informe um primeiro episodio valido e ate 100 arquivos.");
  const existing = new Set(season.episodes.map((episode) => Number(episode.episodeNumber)));
  for (let index = 0; index < count; index++) if (existing.has(start + index)) throw new Error(`O episodio ${start + index} ja existe nesta temporada. Nenhum episodio foi substituido.`);
}

function appendEpisodes(season, episodes, start, folder) {
  validateNewEpisodes(season, episodes.length, start);
  const added = episodes.map((episode, index) => ({ ...episode, episodeNumber: start + index, folder }));
  season.episodes = orderedEpisodes({ episodes: [...season.episodes, ...added] });
  season.uploadFolders = [...new Set([...(season.uploadFolders || []), folder])];
  return added;
}

module.exports = { validateNewEpisodes, appendEpisodes };
