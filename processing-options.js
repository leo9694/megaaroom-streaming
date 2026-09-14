const QUALITIES = [480, 720, 1080];

function parseProcessing(value) {
  if (value === undefined) return { enabled: true, qualities: [...QUALITIES] };
  const input = typeof value === "string" ? JSON.parse(value) : value;
  if (!input || typeof input.enabled !== "boolean") throw new Error("Invalid processing options");
  if (!input.enabled) return { enabled: false, qualities: [] };
  if (!Array.isArray(input.qualities) || !input.qualities.length ||
      input.qualities.some((quality) => !QUALITIES.includes(quality))) {
    throw new Error("Select at least one valid quality");
  }
  return { enabled: true, qualities: QUALITIES.filter((quality) => input.qualities.includes(quality)) };
}

function entryProcessing(entry) {
  return parseProcessing(entry.episode?.processing ?? entry.parent.processing);
}

module.exports = { parseProcessing, entryProcessing };
