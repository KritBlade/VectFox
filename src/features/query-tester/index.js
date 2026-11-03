// features/query-tester — the Query Tester: runs one test message through EventBase, ChunkBase and World Info
// retrieval as a dry run and shows what each would inject.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export { openQueryTestModal } from './query-tester.js';
