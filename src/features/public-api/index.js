// features/public-api — the `VectFox` object other extensions call, and the `vectfox_*` events they listen to
// (InternalProject/Vectfox/plans/vectfox-public-api.md): one documented, versioned way in, so an extension reads
// VectFox's data and follows what it does without forking it or importing its files by path.
//
// Re-exports only. Code outside this folder imports the feature here, never its files (.dependency-cruiser.cjs).
export {
    announceCollectionInUseChanged,
    announceEventBaseEventsRemoved,
    announceEventBaseRunEnded,
    announceLlmCallFinished,
    announcePublicApiReady,
    announcePurgedCollection,
    publishPublicApi,
} from './public-api.js';
