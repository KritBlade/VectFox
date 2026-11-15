// identifiers.js — SillyTavern's string hash, which every VectFox chunk and message hash uses, its UUID generator,
// and a character's file name, which keys the extra lorebooks SillyTavern loads for that character.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export { getCharaFilename, getStringHash, uuidv4 } from '../../../../../utils.js';
