/**
 * Where a Vectra collection lives on disk: the folder SillyTavern's own vector routes use, so a collection written
 * through Similharity and one written without it are the same collection.
 *
 * SillyTavern keeps a collection in vectors/<source>/<collectionId>/<model>/ (getIndex in src/endpoints/vectors.js).
 * For Transformers the model is the one config.yaml names, extensions.models.embedding, whatever the request says;
 * every other source takes the request's model. VectFox names no model for Transformers, so an empty model there
 * means config.yaml's. A model the request names is used as it is, so the Database Browser reaches every folder its
 * discovery lists.
 *
 * Similharity kept a Transformers collection with no model named at the top of its folder,
 * vectors/transformers/<collectionId>/index.json, where SillyTavern never looks. moveTopLevelTransformersIndexes
 * moves each one into the model folder.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import sanitize from 'sanitize-filename';
import vectra from 'vectra';

const TRANSFORMERS = 'transformers';
const INDEX_FILE = 'index.json';

/**
 * The model folder a collection's index sits in, '' for none.
 *
 * @param {string} source - The embedding source, such as 'transformers' or 'ollama'
 * @param {string} model - The model the request names, '' for none
 * @param {string} configuredTransformersModel - config.yaml's extensions.models.embedding
 * @returns {string}
 */
export function vectraModelFolder(source, model, configuredTransformersModel) {
    if (source === TRANSFORMERS && !model) return configuredTransformersModel || '';
    return model || '';
}

/**
 * The folder holding a collection's index.json.
 *
 * @param {string} vectorsPath - The user's vectors directory
 * @param {string} collectionId
 * @param {string} source
 * @param {string} modelFolder - From vectraModelFolder
 * @returns {string}
 */
export function vectraIndexFolder(vectorsPath, collectionId, source, modelFolder) {
    const collectionFolder = path.join(vectorsPath, sanitize(source), sanitize(collectionId));
    return modelFolder ? path.join(collectionFolder, sanitize(modelFolder)) : collectionFolder;
}

/**
 * How many items an index file holds, or null when there is no index file.
 *
 * @param {string} indexFile
 * @returns {Promise<number|null>}
 */
async function countIndexItems(indexFile) {
    let text;
    try {
        text = await fs.readFile(indexFile, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const items = JSON.parse(text)?.items;
    return Array.isArray(items) ? items.length : 0;
}

/**
 * Delete every item whose hash an item stored after it repeats, keeping the newest of each hash. An item with no
 * hash is kept.
 *
 * @param {string} indexFolder
 * @returns {Promise<number>} How many items were deleted
 */
async function dropRepeatedHashes(indexFolder) {
    const store = new vectra.LocalIndex(indexFolder);
    const items = await store.listItems();
    const seenHashes = new Set();
    const repeats = [];
    for (let position = items.length - 1; position >= 0; position--) {
        const hash = items[position].metadata?.hash;
        if (hash === undefined || hash === null) continue;
        const key = String(hash);
        if (seenHashes.has(key)) repeats.push(items[position]);
        else seenHashes.add(key);
    }
    if (repeats.length === 0) return 0;
    await store.beginUpdate();
    for (const item of repeats) await store.deleteItem(item.id);
    await store.endUpdate();
    return repeats.length;
}

/**
 * Move one collection's top-level index into its model folder.
 *
 * @returns {Promise<{outcome: 'moved'|'kept'|'emptied', itemCount?: number, droppedCount?: number}|null>}
 *   null when the collection has no top-level index
 */
async function moveCollection(collectionFolder, modelFolder) {
    const topItemCount = await countIndexItems(path.join(collectionFolder, INDEX_FILE));
    if (topItemCount === null) return null;

    // An empty top-level index is one a read made there; nothing in it needs keeping.
    if (topItemCount === 0) {
        await fs.rm(path.join(collectionFolder, INDEX_FILE));
        return { outcome: 'emptied' };
    }

    if ((await countIndexItems(path.join(modelFolder, INDEX_FILE))) > 0) return { outcome: 'kept', itemCount: topItemCount };

    // index.json moves first: a rename replaces the model folder's empty index in one step.
    await fs.mkdir(modelFolder, { recursive: true });
    await fs.rename(path.join(collectionFolder, INDEX_FILE), path.join(modelFolder, INDEX_FILE));
    for (const entry of await fs.readdir(collectionFolder, { withFileTypes: true })) {
        if (entry.isFile()) await fs.rename(path.join(collectionFolder, entry.name), path.join(modelFolder, entry.name));
    }
    const droppedCount = await dropRepeatedHashes(modelFolder);
    return { outcome: 'moved', itemCount: topItemCount, droppedCount };
}

/**
 * Move each Transformers collection kept at the top of its folder into the model folder SillyTavern reads, named by
 * config.yaml. For each collection:
 * - a top-level index with no items is deleted;
 * - a top-level index with items moves into the model folder when that folder holds no items, replacing its empty
 *   index, and repeated hashes are dropped, keeping the newest;
 * - when both hold items, both stay, and the collection is listed as kept.
 * A collection that fails is logged and the rest go on. Nothing happens when config.yaml names no Transformers model,
 * since SillyTavern then reads the top of the folder too.
 *
 * @param {string} vectorsPath - The user's vectors directory
 * @param {string} configuredTransformersModel - config.yaml's extensions.models.embedding
 * @param {{log: Function, warn: Function}} [logger=console]
 * @returns {Promise<{moved: string[], kept: string[], emptied: string[]}>} Collection IDs by outcome
 */
export async function moveTopLevelTransformersIndexes(vectorsPath, configuredTransformersModel, logger = console) {
    const result = { moved: [], kept: [], emptied: [] };
    const modelFolderName = sanitize(configuredTransformersModel || '');
    if (!modelFolderName) return result;

    const sourceFolder = path.join(vectorsPath, sanitize(TRANSFORMERS));
    let entries;
    try {
        entries = await fs.readdir(sourceFolder, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return result;
        throw error;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const collectionFolder = path.join(sourceFolder, entry.name);
        const modelFolder = path.join(collectionFolder, modelFolderName);
        try {
            const moved = await moveCollection(collectionFolder, modelFolder);
            if (!moved) continue;
            result[moved.outcome].push(entry.name);
            if (moved.outcome === 'moved') {
                logger.log(`[similharity] Transformers collection "${entry.name}": moved ${moved.itemCount} items into its model folder "${modelFolderName}", ${moved.droppedCount} repeated hashes dropped.`);
            } else if (moved.outcome === 'kept') {
                logger.warn(`[similharity] Transformers collection "${entry.name}": ${moved.itemCount} items at the top of its folder and more in its model folder "${modelFolderName}", so both stay. SillyTavern and Similharity read only the model folder.`);
            }
        } catch (error) {
            logger.warn(`[similharity] Transformers collection "${entry.name}" was not moved into its model folder:`, error);
        }
    }
    return result;
}
