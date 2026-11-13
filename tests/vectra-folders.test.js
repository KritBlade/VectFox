// Tests that a Vectra collection lives in the folder SillyTavern's own vector routes use, config.yaml's model for
// Transformers when the request names none, and that a Transformers collection kept at the top of its folder moves
// into that model folder once. Real Vectra indexes in a temporary folder.
//
//   node --test tests/

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import vectra from 'vectra';
import { moveTopLevelTransformersIndexes, vectraIndexFolder, vectraModelFolder } from '../vectra-folders.js';

const CONFIGURED_MODEL = 'Cohee/jina-embeddings-v2-base-en';
const MODEL_FOLDER = sanitize(CONFIGURED_MODEL);

let vectorsPath;

beforeEach(async () => {
    vectorsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'similharity-vectra-folders-'));
});

afterEach(async () => {
    await fs.rm(vectorsPath, { recursive: true, force: true });
});

/** A logger that keeps what it was told. */
function recordingLogger() {
    const lines = { log: [], warn: [] };
    return { lines, log: (...parts) => lines.log.push(parts.join(' ')), warn: (...parts) => lines.warn.push(parts.join(' ')) };
}

/** Make a Vectra index in `folder` holding one item per entry, in order. */
async function writeIndex(folder, entries) {
    const store = new vectra.LocalIndex(folder);
    await store.createIndex();
    if (entries.length === 0) return;
    await store.beginUpdate();
    for (const { hash, text } of entries) {
        await store.insertItem({ vector: [0.1, 0.2, 0.3], metadata: { hash, text } });
    }
    await store.endUpdate();
}

/** The items an index folder holds, as `hash:text`, or null when it has no index. */
async function readIndex(folder) {
    const store = new vectra.LocalIndex(folder);
    if (!await store.isIndexCreated()) return null;
    return (await store.listItems()).map(item => `${item.metadata.hash}:${item.metadata.text}`);
}

const transformersCollection = collectionId => path.join(vectorsPath, 'transformers', collectionId);
const inModelFolder = collectionId => path.join(transformersCollection(collectionId), MODEL_FOLDER);

test('the model folder: config.yaml\'s for Transformers when the request names none, else the request\'s', () => {
    assert.equal(vectraModelFolder('transformers', '', CONFIGURED_MODEL), CONFIGURED_MODEL);
    assert.equal(vectraModelFolder('transformers', 'a-folder-discovery-listed', CONFIGURED_MODEL), 'a-folder-discovery-listed');
    assert.equal(vectraModelFolder('transformers', '', ''), '');
    assert.equal(vectraModelFolder('ollama', 'bge-m3:latest', CONFIGURED_MODEL), 'bge-m3:latest');
    assert.equal(vectraModelFolder('ollama', '', CONFIGURED_MODEL), '');
});

test('the index folder is the one SillyTavern builds: vectors/<source>/<collection>/<model>, cleaned as a file name', () => {
    assert.equal(
        vectraIndexFolder(vectorsPath, 'chat_alpha', 'transformers', CONFIGURED_MODEL),
        path.join(vectorsPath, 'transformers', 'chat_alpha', 'Coheejina-embeddings-v2-base-en'),
    );
    assert.equal(vectraIndexFolder(vectorsPath, 'chat_alpha', 'ollama', ''), path.join(vectorsPath, 'ollama', 'chat_alpha'));
});

test('a top-level Transformers index moves into the model folder, keeping the newest item of a repeated hash', async () => {
    await writeIndex(transformersCollection('chat_alpha'), [
        { hash: 11, text: 'first copy' },
        { hash: 22, text: 'lighthouse' },
        { hash: 11, text: 'second copy' },
    ]);
    const logger = recordingLogger();

    const result = await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, logger);

    assert.deepEqual(result, { moved: ['chat_alpha'], kept: [], emptied: [] });
    assert.deepEqual(await readIndex(inModelFolder('chat_alpha')), ['22:lighthouse', '11:second copy']);
    await assert.rejects(fs.access(path.join(transformersCollection('chat_alpha'), 'index.json')), { code: 'ENOENT' });
    assert.match(logger.lines.log[0], /moved 3 items into its model folder "Coheejina-embeddings-v2-base-en", 1 repeated hashes dropped/);
});

test('it replaces the empty index a SillyTavern read left in the model folder', async () => {
    await writeIndex(transformersCollection('chat_alpha'), [{ hash: 11, text: 'harbor' }]);
    await writeIndex(inModelFolder('chat_alpha'), []);

    const result = await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, recordingLogger());

    assert.deepEqual(result.moved, ['chat_alpha']);
    assert.deepEqual(await readIndex(inModelFolder('chat_alpha')), ['11:harbor']);
});

test('every other file at the top of the folder moves with the index', async () => {
    await writeIndex(transformersCollection('chat_alpha'), [{ hash: 11, text: 'harbor' }]);
    await fs.writeFile(path.join(transformersCollection('chat_alpha'), 'item-metadata.json'), '{"text":"harbor"}');

    await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, recordingLogger());

    assert.equal(await fs.readFile(path.join(inModelFolder('chat_alpha'), 'item-metadata.json'), 'utf8'), '{"text":"harbor"}');
    await assert.rejects(fs.access(path.join(transformersCollection('chat_alpha'), 'item-metadata.json')), { code: 'ENOENT' });
});

test('an empty top-level index is deleted, and the model folder is left alone', async () => {
    await writeIndex(transformersCollection('chat_alpha'), []);
    await writeIndex(inModelFolder('chat_alpha'), [{ hash: 11, text: 'harbor' }]);

    const result = await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, recordingLogger());

    assert.deepEqual(result, { moved: [], kept: [], emptied: ['chat_alpha'] });
    assert.equal(await readIndex(transformersCollection('chat_alpha')), null);
    assert.deepEqual(await readIndex(inModelFolder('chat_alpha')), ['11:harbor']);
});

test('when both folders hold items, both stay and a warning names the collection', async () => {
    await writeIndex(transformersCollection('chat_alpha'), [{ hash: 11, text: 'at the top' }]);
    await writeIndex(inModelFolder('chat_alpha'), [{ hash: 22, text: 'in the model folder' }]);
    const logger = recordingLogger();

    const result = await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, logger);

    assert.deepEqual(result, { moved: [], kept: ['chat_alpha'], emptied: [] });
    assert.deepEqual(await readIndex(transformersCollection('chat_alpha')), ['11:at the top']);
    assert.deepEqual(await readIndex(inModelFolder('chat_alpha')), ['22:in the model folder']);
    assert.match(logger.lines.warn[0], /"chat_alpha": 1 items at the top of its folder and more in its model folder/);
});

test('nothing moves when config.yaml names no Transformers model, since SillyTavern then reads the top folder', async () => {
    await writeIndex(transformersCollection('chat_alpha'), [{ hash: 11, text: 'harbor' }]);

    const result = await moveTopLevelTransformersIndexes(vectorsPath, '', recordingLogger());

    assert.deepEqual(result, { moved: [], kept: [], emptied: [] });
    assert.deepEqual(await readIndex(transformersCollection('chat_alpha')), ['11:harbor']);
});

test('a second run finds nothing to move and changes nothing', async () => {
    await writeIndex(transformersCollection('chat_alpha'), [{ hash: 11, text: 'harbor' }]);
    await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, recordingLogger());

    const result = await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, recordingLogger());

    assert.deepEqual(result, { moved: [], kept: [], emptied: [] });
    assert.deepEqual(await readIndex(inModelFolder('chat_alpha')), ['11:harbor']);
});

test('other sources are left where they are', async () => {
    const ollamaCollection = path.join(vectorsPath, 'ollama', 'chat_alpha');
    await writeIndex(ollamaCollection, [{ hash: 11, text: 'harbor' }]);

    await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, recordingLogger());

    assert.deepEqual(await readIndex(ollamaCollection), ['11:harbor']);
});

test('no Transformers folder at all is not an error', async () => {
    assert.deepEqual(await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, recordingLogger()), { moved: [], kept: [], emptied: [] });
});

test('a collection whose index cannot be read is logged, and the others still move', async () => {
    await fs.mkdir(transformersCollection('chat_broken'), { recursive: true });
    await fs.writeFile(path.join(transformersCollection('chat_broken'), 'index.json'), '{ not json');
    await writeIndex(transformersCollection('chat_alpha'), [{ hash: 11, text: 'harbor' }]);
    const logger = recordingLogger();

    const result = await moveTopLevelTransformersIndexes(vectorsPath, CONFIGURED_MODEL, logger);

    assert.deepEqual(result.moved, ['chat_alpha']);
    assert.match(logger.lines.warn.join('\n'), /"chat_broken" was not moved into its model folder/);
    assert.equal(await fs.readFile(path.join(transformersCollection('chat_broken'), 'index.json'), 'utf8'), '{ not json');
});
