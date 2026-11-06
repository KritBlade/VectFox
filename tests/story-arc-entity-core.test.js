/**
 * Tests for StoryArc's entity merges (src/features/eventbase/story-arc-entity-core.js).
 *
 * Guards that:
 *   - events read with the kept name, and the stored events stay as they are,
 *   - a short name inside a different person's name is left alone, while a full name holding it as a part and a one-off spelling are rewritten,
 *   - the search asks for the other names of anyone the question names, except the rare ones,
 *   - the entity list counts a merged entity once and never loses one that no tag names,
 *   - merging carries a source's own other names, and splitting undoes it.
 *
 * A name in CJK script takes its own path, matching as a substring and not as a whole
 * word. The tests of that path use plain words in place of names, which stay English.
 */

import { describe, it, expect } from 'vitest';
import {
    buildEntityNameWriter,
    entityNamesInMessage,
    entityNamesLeftAlone,
    entitySearchText,
    filterEntities,
    hasEntityMerges,
    listEntities,
    mergeEntityNames,
    splitEntityName,
    withKeptEntityNames,
} from '../src/features/eventbase/story-arc-entity-core.js';

describe('buildEntityNameWriter', () => {
    it('writes every other name as its kept name', () => {
        const writeName = buildEntityNameWriter({ Rose: ['Rosie', '玫瑰'] });
        expect(writeName('Rosie met 玫瑰 and Rose')).toBe('Rose met Rose and Rose');
    });

    it('leaves text alone with no merges', () => {
        expect(buildEntityNameWriter({})('Rosie')).toBe('Rosie');
    });

    it('takes a Latin name only as a whole word, in any case', () => {
        const writeName = buildEntityNameWriter({ Rose: ['Dorin'] });
        expect(writeName('DORIN and Dorinda, Dorin的劍')).toBe('Rose and Dorinda, Rose的劍');
    });

    it('prefers the longest name where names overlap', () => {
        const writeName = buildEntityNameWriter({ 雪: ['石頭·藍', '石頭'] });
        expect(writeName('石頭·藍 見 石頭')).toBe('雪 見 雪');
    });

    it('leaves a different person\'s longer name alone, when several events tag it', () => {
        const events = Array.from({ length: 3 }, () => ({ characters: ['大石頭'] }));
        const writeName = buildEntityNameWriter({ 雪: ['石頭'] }, events);
        expect(writeName('石頭 和 大石頭')).toBe('雪 和 大石頭');
    });

    it('takes a one-off spelling, such as the name with a title on it', () => {
        const events = [{ characters: ['女神石頭'] }, { characters: ['石頭女神'] }];
        const writeName = buildEntityNameWriter({ 雪: ['石頭'] }, events);
        expect(writeName('女神石頭 和 石頭女神')).toBe('女神雪 和 雪女神');
    });

    it('rewrites a full name that holds the other name as a part', () => {
        const events = Array.from({ length: 3 }, () => ({ characters: ['石頭·霜'] }));
        const writeName = buildEntityNameWriter({ 雪: ['石頭'] }, events);
        expect(writeName('石頭·霜')).toBe('雪·霜');
    });

    it('leaves a kept name that holds an other name alone', () => {
        const writeName = buildEntityNameWriter({ 大石頭: ['石頭'] });
        expect(writeName('大石頭 又名 石頭')).toBe('大石頭 又名 大石頭');
    });

    it('takes a place name inside a longer place tag', () => {
        const events = [{ locations: ['河谷村.大宅'] }];
        const writeName = buildEntityNameWriter({ Valley: ['河谷'] }, events);
        expect(writeName('河谷村.大宅')).toBe('Valley村.大宅');
    });
});

describe('entityNamesLeftAlone', () => {
    it('names the longer names that stay their own', () => {
        const events = Array.from({ length: 3 }, () => ({ characters: ['大石頭', '石頭·霜', 'Tom'] }));
        expect(entityNamesLeftAlone({ 雪: ['石頭'] }, [...events, { characters: ['女神石頭'] }])).toEqual(['大石頭']);
    });
});

describe('withKeptEntityNames', () => {
    it('rewrites what a reader sees, thread names too, and leaves the stored events unchanged', () => {
        const stored = [{
            _hash: 1,
            event_id: 'Rosie-1',
            text: 'Rosie wins',
            cause: 'Rosie trains',
            characters: ['Rosie', 'Tom'],
            story_links: [{ event_id: 'x', type: 'continues', thread: 'Rosie trains' }],
        }];
        const [written] = withKeptEntityNames(stored, buildEntityNameWriter({ Rose: ['Rosie'] }));
        expect(written.text).toBe('Rose wins');
        expect(written.cause).toBe('Rose trains');
        expect(written.characters).toEqual(['Rose', 'Tom']);
        expect(written.story_links[0].thread).toBe('Rose trains');
        expect(written.event_id).toBe('Rosie-1');
        expect(stored[0].text).toBe('Rosie wins');
        expect(stored[0].story_links[0].thread).toBe('Rosie trains');
    });
});

describe('entitySearchText', () => {
    const eventsHolding = (name, count) => Array.from({ length: count }, () => ({ text: `${name} acts` }));

    it('adds the other names of someone the question names', () => {
        const storedEvents = [...eventsHolding('Rose', 5), ...eventsHolding('Rosa', 5)];
        expect(entitySearchText({ queryText: 'How did Rose win?', subject: '', merges: { Rose: ['Rosa'] }, storedEvents })).toBe('How did Rose win? Rosa');
    });

    it('adds them when only the subject names the entity', () => {
        const storedEvents = [...eventsHolding('Rose', 5), ...eventsHolding('Rosa', 5)];
        expect(entitySearchText({ queryText: 'How did you win?', subject: 'rose', merges: { Rose: ['Rosa'] }, storedEvents })).toBe('How did you win? Rose Rosa');
    });

    it('leaves a rare name out of the search', () => {
        const storedEvents = [...eventsHolding('Rose', 95), ...eventsHolding('Rosie', 5), ...eventsHolding('Rosa', 20)];
        expect(entitySearchText({ queryText: 'How did Rose win?', subject: '', merges: { Rose: ['Rosie', 'Rosa'] }, storedEvents })).toBe('How did Rose win? Rosa');
    });

    it('adds the main name when the question uses the rare one', () => {
        const storedEvents = [...eventsHolding('Rose', 95), ...eventsHolding('Rosie', 5)];
        expect(entitySearchText({ queryText: 'How did Rosie win?', subject: '', merges: { Rose: ['Rosie'] }, storedEvents })).toBe('How did Rosie win? Rose');
    });

    it('changes nothing for a question about someone else', () => {
        const storedEvents = eventsHolding('Rose', 5);
        expect(entitySearchText({ queryText: 'How did Tom win?', subject: 'Tom', merges: { Rose: ['Rosa'] }, storedEvents })).toBe('How did Tom win?');
    });
});

describe('entityNamesInMessage', () => {
    it('names the other names a message uses', () => {
        expect(entityNamesInMessage('Rosie and Tom', { Rose: ['Rosie', 'Rosa'] })).toEqual([{ name: 'Rosie', keptName: 'Rose' }]);
    });
});

describe('listEntities', () => {
    const events = [
        { text: 'Rose', characters: ['Rose', 'Tom'], locations: ['Bay'] },
        { text: 'Rosa', characters: ['Rosa'] },
        { text: 'Rose and Rosa', characters: ['Rose', 'Rosa'] },
        { text: 'Tom', characters: ['Tom ', 'Tom'] },
    ];

    it('lists one kind, most named first, counting a tag once per event', () => {
        expect(listEntities(events, {}, 'people')).toEqual([
            { name: 'Rosa', otherNames: [], eventCount: 2 },
            { name: 'Rose', otherNames: [], eventCount: 2 },
            { name: 'Tom', otherNames: [], eventCount: 2 },
        ]);
        expect(listEntities(events, {}, 'places')).toEqual([{ name: 'Bay', otherNames: [], eventCount: 1 }]);
    });

    it('shows a merged entity once, counting each event naming it once', () => {
        expect(listEntities(events, { Rose: ['Rosa'] }, 'people')).toEqual([
            { name: 'Rose', otherNames: ['Rosa'], eventCount: 3 },
            { name: 'Tom', otherNames: [], eventCount: 2 },
        ]);
    });

    it('keeps a merged entity no tag names, so it can be split again', () => {
        expect(listEntities(events, { Harbour: ['Port'] }, 'people')[3]).toEqual({ name: 'Harbour', otherNames: ['Port'], eventCount: 0 });
    });

    it('shows a merged entity under the kind that tags its other name', () => {
        expect(listEntities(events, { Harbour: ['Bay'] }, 'places')).toEqual([{ name: 'Harbour', otherNames: ['Bay'], eventCount: 0 }]);
        expect(listEntities(events, { Harbour: ['Bay'] }, 'people').map(row => row.name)).not.toContain('Harbour');
    });
});

describe('filterEntities', () => {
    it('finds a row by any of its names, in any case', () => {
        const rows = [{ name: 'Rose', otherNames: ['Rosa'] }, { name: 'Tom', otherNames: [] }];
        expect(filterEntities(rows, 'rosa').map(row => row.name)).toEqual(['Rose']);
        expect(filterEntities(rows, 'TOM').map(row => row.name)).toEqual(['Tom']);
        expect(filterEntities(rows, '  ')).toEqual(rows);
    });
});

describe('mergeEntityNames', () => {
    it('makes the source an other name of the target', () => {
        const { isMerged, merges } = mergeEntityNames({}, 'Rosa', 'Rose');
        expect(isMerged).toBe(true);
        expect(merges).toEqual({ Rose: ['Rosa'] });
        expect(hasEntityMerges(merges)).toBe(true);
    });

    it('carries the source\'s own other names', () => {
        const { merges } = mergeEntityNames({ Rosa: ['Rosie'] }, 'Rosa', 'Rose');
        expect(merges).toEqual({ Rose: ['Rosa', 'Rosie'] });
    });

    it('resolves a target that is already an other name', () => {
        const { merges } = mergeEntityNames({ Rose: ['Rosie'] }, 'Rosa', 'rosie');
        expect(merges).toEqual({ Rose: ['Rosie', 'Rosa'] });
    });

    it('refuses a name already in the target\'s entity', () => {
        const before = { Rose: ['Rosie'] };
        const result = mergeEntityNames(before, 'Rosie', 'ROSE');
        expect(result.isMerged).toBe(false);
        expect(result.reason).toContain('already one entity');
        expect(result.merges).toBe(before);
    });

    it('refuses an empty target', () => {
        expect(mergeEntityNames({}, 'Rose', '  ').isMerged).toBe(false);
    });

    it('leaves the merges it was given unchanged', () => {
        const before = { Rose: ['Rosie'] };
        mergeEntityNames(before, 'Rosa', 'Rose');
        expect(before).toEqual({ Rose: ['Rosie'] });
    });
});

describe('splitEntityName', () => {
    it('takes one name out and keeps the rest', () => {
        expect(splitEntityName({ Rose: ['Rosie', 'Rosa'] }, 'Rose', 'Rosie')).toEqual({ Rose: ['Rosa'] });
    });

    it('drops an entity left with no other names', () => {
        expect(splitEntityName({ Rose: ['Rosie'] }, 'Rose', 'Rosie')).toEqual({});
        expect(hasEntityMerges({})).toBe(false);
    });
});
