// features/diagnostics — Diagnostics' dialog (Checks, Backend health, Query Tester), the diagnostics runner with its
// infrastructure, configuration, visualizer and production checks, and the backend health pill on the Action page.
//
// The runner and its checks load on the first run, so they stay out of startup: a broken check cannot stop VectFox
// from loading. Re-exports only. Code outside this folder imports the feature here, never its files
// (.dependency-cruiser.cjs).
export { openDiagnostics } from './diagnostics-dialog.js';
export { getHealthPillHtml, refreshHealthPill } from './backend-health.js';
