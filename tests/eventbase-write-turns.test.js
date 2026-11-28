/**
 * The turns of the writes to a collection's events that must never cross (src/features/eventbase/eventbase-write-turns.js):
 * field writes, StoryArc's links among them, go on together; a text edit waits for the field writes under way, and the
 * field writes that come while it runs wait for it; text edits of one collection go one at a time, in the order they
 * came; another collection never waits; a failed write ends its turn all the same; and writeStoredFields sets a
 * point's fields through the payload route in its turn.
 */

import { describe, expect, it, vi } from 'vitest';

const updateChunkMetadata = vi.fn(async () => ({}));
vi.mock('../src/features/vector-backend/index.js', () => ({ updateChunkMetadata: (...args) => updateChunkMetadata(...args) }));

const { inFieldWriteTurn, inTextEditTurn, writeStoredFields } = await import('../src/features/eventbase/eventbase-write-turns.js');

/** A write that ends when the test says so, and says when it started. */
function heldWrite() {
    const held = { hasStarted: false };
    held.ended = new Promise((resolve, reject) => { held.end = resolve; held.fail = reject; });
    held.run = () => {
        held.hasStarted = true;
        return held.ended;
    };
    return held;
}

/** Let every write that can move on do so. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('field writes', () => {
    it('go on together in one collection', async () => {
        const first = heldWrite();
        const second = heldWrite();
        const writes = [inFieldWriteTurn('fields-together', first.run), inFieldWriteTurn('fields-together', second.run)];
        await settle();
        expect([first.hasStarted, second.hasStarted]).toEqual([true, true]);
        first.end('first');
        second.end('second');
        expect(await Promise.all(writes)).toEqual(['first', 'second']);
    });

    it('set a point\'s fields through the payload route, after a text edit that holds the collection', async () => {
        const edit = heldWrite();
        const edited = inTextEditTurn('fields-after-edit', edit.run);
        await settle();
        const settings = { vector_backend: 'qdrant' };
        const written = writeStoredFields('fields-after-edit', 7001, { importance: 9 }, settings);
        await settle();
        expect(updateChunkMetadata).not.toHaveBeenCalled();
        edit.end();
        await edited;
        await written;
        expect(updateChunkMetadata).toHaveBeenCalledWith('fields-after-edit', 7001, { importance: 9 }, settings);
    });
});

describe('a text edit', () => {
    it('waits for the field writes under way, and starts once the last one ends', async () => {
        const firstField = heldWrite();
        const secondField = heldWrite();
        const edit = heldWrite();
        const fields = [inFieldWriteTurn('edit-after-fields', firstField.run), inFieldWriteTurn('edit-after-fields', secondField.run)];
        const edited = inTextEditTurn('edit-after-fields', edit.run);
        await settle();
        expect(edit.hasStarted).toBe(false);
        firstField.end();
        await settle();
        expect(edit.hasStarted).toBe(false);
        secondField.end();
        await settle();
        expect(edit.hasStarted).toBe(true);
        edit.end('edited');
        expect(await edited).toBe('edited');
        await Promise.all(fields);
    });

    it('holds back the field writes that come while it runs, until it ends', async () => {
        const edit = heldWrite();
        const field = heldWrite();
        const edited = inTextEditTurn('fields-during-edit', edit.run);
        await settle();
        expect(edit.hasStarted).toBe(true);
        const written = inFieldWriteTurn('fields-during-edit', field.run);
        await settle();
        expect(field.hasStarted).toBe(false);
        edit.end();
        await edited;
        await settle();
        expect(field.hasStarted).toBe(true);
        field.end();
        await written;
    });

    it('goes after the text edits of its collection that came before it, one at a time', async () => {
        const first = heldWrite();
        const second = heldWrite();
        const edits = [inTextEditTurn('edits-in-order', first.run), inTextEditTurn('edits-in-order', second.run)];
        await settle();
        expect([first.hasStarted, second.hasStarted]).toEqual([true, false]);
        first.end();
        await settle();
        expect(second.hasStarted).toBe(true);
        second.end();
        await Promise.all(edits);
    });

    it("never waits for another collection's writes", async () => {
        const field = heldWrite();
        const otherEdit = heldWrite();
        const written = inFieldWriteTurn('harbor', field.run);
        const edited = inTextEditTurn('lighthouse', otherEdit.run);
        await settle();
        expect(otherEdit.hasStarted).toBe(true);
        otherEdit.end();
        field.end();
        await Promise.all([written, edited]);
    });
});

describe('a failed write', () => {
    it('ends its turn, so the writes after it go on', async () => {
        const edit = heldWrite();
        const nextEdit = heldWrite();
        const failedEdit = inTextEditTurn('after-failures', edit.run);
        const edited = inTextEditTurn('after-failures', nextEdit.run);
        await settle();
        edit.fail(new Error('the embedding failed'));
        await expect(failedEdit).rejects.toThrow('the embedding failed');
        await settle();
        expect(nextEdit.hasStarted).toBe(true);
        nextEdit.end();
        await edited;

        const field = heldWrite();
        const afterField = heldWrite();
        const failedField = inFieldWriteTurn('after-failures', field.run);
        const editAfterField = inTextEditTurn('after-failures', afterField.run);
        await settle();
        field.fail(new Error('Qdrant is down'));
        await expect(failedField).rejects.toThrow('Qdrant is down');
        await settle();
        expect(afterField.hasStarted).toBe(true);
        afterField.end();
        await editAfterField;
    });
});
