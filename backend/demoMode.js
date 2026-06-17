/** When false (production default), skip local/bundled embedding fallbacks — use S3 + Step Functions only. */
function isEmbeddingsDemoEnabled() {
  return String(process.env.ALLOW_EMBEDDINGS_DEMO || '').toLowerCase() === 'true';
}

module.exports = {
  isEmbeddingsDemoEnabled,
};
