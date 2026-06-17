/**
 * Production builds set REACT_APP_USE_PIPELINE_DEMO=false (default).
 * Testing/demo Amplify can set true to serve bundled PCA/tags without S3 pipeline output.
 */
export function isPipelineDemoMode() {
  return process.env.REACT_APP_USE_PIPELINE_DEMO === 'true';
}
