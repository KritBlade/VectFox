// identifiers.js — SillyTavern's string hash, which every VectFox chunk and message hash uses, its UUID generator,
// a character's file name, which keys the extra lorebooks SillyTavern loads for that character, and the server's
// file-name cleaner, which says the name a renamed chat's file was saved under.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getCharaFilename, getSanitizedFilename, getStringHash, uuidv4 } from '../../../../../utils.js';
