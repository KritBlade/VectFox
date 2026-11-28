/**
 * The turns of the writes to a collection's events that must never cross (src/features/eventbase/eventbase-write-turns.js):
 * StoryArc's link writes go on together; a text edit waits for the link writes under way, and the link writes that
 * come while it runs wait for it; text edits of one collection go one at a time, in the order they came; another
 * collection never waits; and a failed write ends its turn all the same.
 */

import { describe, expect, it } from 'vitest';

const { inStoryLinkWriteTurn, inTextEditTurn } = await import('../src/features/eventbase/eventbase-write-turns.js');

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

describe('StoryArc link writes', () => {
    it('go on together in one collection', async () => {
        const first = heldWrite();
        const second = heldWrite();
        const writes = [inStoryLinkWriteTurn('links-together', first.run), inStoryLinkWriteTurn('links-together', second.run)];
        await settle();
        expect([first.hasStarted, second.hasStarted]).toEqual([true, true]);
        first.end('first');
        second.end('second');
        expect(await Promise.all(writes)).toEqual(['first', 'second']);
    });
});

describe('a text edit', () => {
    it('waits for the link writes under way, and starts once the last one ends', async () => {
        const firstLink = heldWrite();
        const secondLink = heldWrite();
        const edit = heldWrite();
        const links = [inStoryLinkWriteTurn('edit-after-links', firstLink.run), inStoryLinkWriteTurn('edit-after-links', secondLink.run)];
        const edited = inTextEditTurn('edit-after-links', edit.run);
        await settle();
        expect(edit.hasStarted).toBe(false);
        firstLink.end();
        await settle();
        expect(edit.hasStarted).toBe(false);
        secondLink.end();
        await settle();
        expect(edit.hasStarted).toBe(true);
        edit.end('edited');
        expect(await edited).toBe('edited');
        await Promise.all(links);
    });

    it('holds back the link writes that come while it runs, until it ends', async () => {
        const edit = heldWrite();
        const link = heldWrite();
        const edited = inTextEditTurn('links-after-edit', edit.run);
        await settle();
        expect(edit.hasStarted).toBe(true);
        const linked = inStoryLinkWriteTurn('links-after-edit', link.run);
        await settle();
        expect(link.hasStarted).toBe(false);
        edit.end();
        await edited;
        await settle();
        expect(link.hasStarted).toBe(true);
        link.end();
        await linked;
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
        const link = heldWrite();
        const otherEdit = heldWrite();
        const linked = inStoryLinkWriteTurn('harbor', link.run);
        const edited = inTextEditTurn('lighthouse', otherEdit.run);
        await settle();
        expect(otherEdit.hasStarted).toBe(true);
        otherEdit.end();
        link.end();
        await Promise.all([linked, edited]);
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

        const link = heldWrite();
        const afterLink = heldWrite();
        const failedLink = inStoryLinkWriteTurn('after-failures', link.run);
        const editAfterLink = inTextEditTurn('after-failures', afterLink.run);
        await settle();
        link.fail(new Error('Qdrant is down'));
        await expect(failedLink).rejects.toThrow('Qdrant is down');
        await settle();
        expect(afterLink.hasStarted).toBe(true);
        afterLink.end();
        await editAfterLink;
    });
});
