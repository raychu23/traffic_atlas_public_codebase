export const SAMPLE_UPLOAD_LIMIT_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
export const FULL_UPLOAD_LIMIT_BYTES = null; // no limit

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1024) {
    const tb = gb / 1024;
    return `${tb.toFixed(2)} TB`;
  }
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
};

export const formatUploadLimit = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unlimited';
  return formatBytes(bytes);
};
