/**
 * Tests for StoryArc's entity merges (src/features/eventbase/story-arc-entity-core.js).
 *
 * Guards that:
 *   - events read with the kept name, and the stored events stay as they are,
 *   - a short name inside a different person's name is left alone, while a full name holding it as a part and a one-off spelling are rewritten,
 *   - the search asks for the other names of anyone the question names, except the rare ones,
 *   - the entity list counts a merged entity once and never loses one that no tag names,
 *   - merging carries a source's own other names, and splitting undoes it,
 *   - a name's spellings that differ only in case are one name, in the list, the hidden names, a merge and the search,
 *   - a Chinese, Japanese, Thai, Lao, Khmer or Burmese name counts only where it stands as a word, so a merged 家 never rewrites or counts 家族,
 *   - a Latin-script name, accented or not, counts only as a whole word, so a merged Zoë never rewrites Zoëlla,
 *   - a Korean name counts only where it starts a word with only particles after it, so a merged 바다 never rewrites 앞바다.
 *
 * A name in a script written without spaces is found where the runtime's word splitter
 * starts and ends a word, and a Korean one where it starts a word followed only by
 * particles. The tests of those paths use plain words in place of names, which stay English.
 */

import { describe, it, expect } from 'vitest';
import {
    buildEntityNameWriter,
    entityNamesInMessage,
    entityNamesLeftAlone,
    entitySearchText,
    filterEntities,
    hasEntityMerges,
    isHiddenEntityName,
    listEntities,
    mergeEntityNames,
    separateHiddenEntities,
    showEntityNameAgain,
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

    it('takes an accented Latin name only as a whole word, in any case', () => {
        const writeName = buildEntityNameWriter({ Rose: ['Zoë'] });
        expect(writeName('Zoëlla, ZOË, 見Zoë and Zoë的劍')).toBe('Zoëlla, Rose, 見Rose and Rose的劍');
    });

    it('counts an accent mark written apart from its letter as part of the word', () => {
        const writeName = buildEntityNameWriter({ Rose: ['Zoe', 'Lou'] });
        expect(writeName('Zoë and Zoe')).toBe('Zoë and Rose');
        expect(writeName('AndréLou and Lou')).toBe('AndréLou and Rose');
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

    it('takes a Chinese or Japanese name only where it stands as a word, never inside a longer word', () => {
        const writeName = buildEntityNameWriter({ 雪: ['家', '我'] });
        expect(writeName('家族 大家 自家料理 他回到家了')).toBe('家族 大家 自家料理 他回到雪了');
        expect(writeName('我們 自我介紹 注意到我沒有')).toBe('我們 自我介紹 注意到雪沒有');
        expect(writeName('家族の写真 母は家に帰った')).toBe('家族の写真 母は雪に帰った');
        const writeKanaName = buildEntityNameWriter({ Sky: ['ソラ'], Bloom: ['さくら'] });
        expect(writeKanaName('ソラマメを食べた ソラが来た さくらんぼ さくらが咲いた')).toBe('ソラマメを食べた Skyが来た さくらんぼ Bloomが咲いた');
    });

    it('takes a Thai, Lao, Khmer or Burmese name only where it stands as a word, never inside a longer word', () => {
        // river, mother goes to market | parents, mother goes | star, beautiful flower | riverbank, big river
        expect(buildEntityNameWriter({ Mother: ['แม่'] })('แม่น้ำ แม่ไปตลาด')).toBe('แม่น้ำ Motherไปตลาด');
        expect(buildEntityNameWriter({ Mother: ['ແມ່'] })('ພໍ່ແມ່ ແມ່ໄປ')).toBe('ພໍ່ແມ່ Motherໄປ');
        expect(buildEntityNameWriter({ Flower: ['ផ្កា'] })('ផ្កាយ ផ្កាស្អាត')).toBe('ផ្កាយ Flowerស្អាត');
        expect(buildEntityNameWriter({ River: ['မြစ်'] })('မြစ်ကမ်း မြစ်ကြီး')).toBe('မြစ်ကမ်း Riverကြီး');
    });

    it('takes a Korean name where it starts a word, with only particles after it in that word', () => {
        const writeName = buildEntityNameWriter({ Sea: ['바다'], Tree: ['나무'], Heaven: ['하늘'] });
        // the sea is seen, offshore, a seal, in the sea | trees, a pine, a woodcutter, a tree. | to heaven, sky blue
        expect(writeName('바다가 보인다 앞바다 바다표범 바다에서는')).toBe('Sea가 보인다 앞바다 바다표범 Sea에서는');
        expect(writeName('나무들이 소나무 나무꾼 나무.')).toBe('Tree들이 소나무 나무꾼 Tree.');
        expect(writeName('하늘님께 하늘색')).toBe('Heaven님께 하늘색');
    });

    it('still reads a one-syllable Korean name inside a word that looks like it with a particle', () => {
        // I too, a country, age: 나이 reads as 나 with the particle 이
        expect(buildEntityNameWriter({ Self: ['나'] })('나도 나라 나이')).toBe('Self도 나라 Self이');
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

    it('finds a name in the question in any case, and a Latin name only as a whole word', () => {
        const storedEvents = [...eventsHolding('Rose', 5), ...eventsHolding('Rosa', 5)];
        expect(entitySearchText({ queryText: 'How did rose win?', subject: '', merges: { Rose: ['Rosa'] }, storedEvents })).toBe('How did rose win? Rosa');
        expect(entitySearchText({ queryText: 'How did Rosalind win?', subject: '', merges: { Rose: ['Rosa'] }, storedEvents })).toBe('How did Rosalind win?');
    });

    it('finds a Chinese name in the question only where it stands as a word', () => {
        const storedEvents = [...eventsHolding('雪', 5), ...eventsHolding('家', 5)];
        expect(entitySearchText({ queryText: '家族的事情', subject: '', merges: { 雪: ['家'] }, storedEvents })).toBe('家族的事情');
        expect(entitySearchText({ queryText: '他回到家了', subject: '', merges: { 雪: ['家'] }, storedEvents })).toBe('他回到家了 雪');
    });
});

describe('entityNamesInMessage', () => {
    it('names the other names a message uses', () => {
        expect(entityNamesInMessage('Rosie and Tom', { Rose: ['Rosie', 'Rosa'] })).toEqual([{ name: 'Rosie', keptName: 'Rose' }]);
    });

    it('names a Korean other name only where the message starts a word with it', () => {
        expect(entityNamesInMessage('앞바다에 갔다', { Sea: ['바다'] })).toEqual([]);
        expect(entityNamesInMessage('바다에 갔다', { Sea: ['바다'] })).toEqual([{ name: '바다', keptName: 'Sea' }]);
    });

    it('names an accented other name only where the message uses it as a whole word', () => {
        expect(entityNamesInMessage('Zoëy and Zoëlla met Renée', { Rose: ['Zoë', 'Renée'] })).toEqual([{ name: 'Renée', keptName: 'Rose' }]);
    });

    it('names a Chinese other name only where the message uses it as a word', () => {
        expect(entityNamesInMessage('大家好，我們走吧', { 雪: ['家', '我'] })).toEqual([]);
        expect(entityNamesInMessage('我說', { 雪: ['家', '我'] })).toEqual([{ name: '我', keptName: '雪' }]);
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

    it('counts a merged Chinese name only in events whose text uses it as a word', () => {
        const chineseEvents = [
            { text: '雪 走了', characters: ['雪'] },
            { text: '他回到家了', characters: ['家'] },
            { text: '家族 的 事', characters: ['Tom'] },
        ];
        expect(listEntities(chineseEvents, { 雪: ['家'] }, 'people')[0]).toEqual({ name: '雪', otherNames: ['家'], eventCount: 2 });
    });

    it('keeps a merged entity no tag names, so it can be split again', () => {
        expect(listEntities(events, { Harbour: ['Port'] }, 'people')[3]).toEqual({ name: 'Harbour', otherNames: ['Port'], eventCount: 0 });
    });

    it('shows a merged entity under the kind that tags its other name', () => {
        expect(listEntities(events, { Harbour: ['Bay'] }, 'places')).toEqual([{ name: 'Harbour', otherNames: ['Bay'], eventCount: 0 }]);
        expect(listEntities(events, { Harbour: ['Bay'] }, 'people').map(row => row.name)).not.toContain('Harbour');
    });

    const casedEvents = [
        { text: 'Rose', characters: ['Rose'] },
        { text: 'Rose', characters: ['Rose', 'rose'] },
        { text: 'ROSE', characters: ['ROSE'] },
        { text: 'Rosie', characters: ['Rosie'] },
    ];

    it('lists a name\'s spellings that differ only in case as one row, in the spelling most events tag', () => {
        expect(listEntities(casedEvents, {}, 'people')).toEqual([
            { name: 'Rose', otherNames: [], eventCount: 3 },
            { name: 'Rosie', otherNames: [], eventCount: 1 },
        ]);
    });

    it('shows a merged entity by its kept name, whichever spelling the events tag', () => {
        expect(listEntities(casedEvents, { rose: ['Rosie'] }, 'people')).toEqual([{ name: 'rose', otherNames: ['Rosie'], eventCount: 4 }]);
        expect(listEntities(casedEvents, { Tom: ['ROSE'] }, 'people')).toEqual([
            { name: 'Tom', otherNames: ['ROSE'], eventCount: 3 },
            { name: 'Rosie', otherNames: [], eventCount: 1 },
        ]);
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

    it('refuses a name already in the target\'s entity, in any case', () => {
        const before = { Rose: ['Rosie'] };
        for (const [sourceName, targetName] of [['Rosie', 'ROSE'], ['rose', 'ROSIE']]) {
            const result = mergeEntityNames(before, sourceName, targetName);
            expect(result.isMerged).toBe(false);
            expect(result.reason).toContain('already one entity');
            expect(result.merges).toBe(before);
        }
        expect(mergeEntityNames({}, 'rose', 'Rose').reason).toContain('already one entity');
    });

    it('resolves a kept name typed in another case to its entity', () => {
        expect(mergeEntityNames({ Rose: ['Rosie'] }, 'Rosa', 'rose')).toEqual({ isMerged: true, merges: { Rose: ['Rosie', 'Rosa'] }, keptName: 'Rose' });
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

describe('mergeEntityNames, the kept name', () => {
    it('names the name the merged entity goes by, through an other name too', () => {
        expect(mergeEntityNames({}, 'Rosa', 'Rose').keptName).toBe('Rose');
        expect(mergeEntityNames({ Rose: ['Rosie'] }, 'Rosa', 'rosie').keptName).toBe('Rose');
    });
});

describe('separateHiddenEntities', () => {
    const rows = [{ name: 'Rose' }, { name: 'Waitress' }, { name: 'Tom' }];

    it('splits the rows by their name in any case, in the order given', () => {
        const { shownRows, hiddenRows } = separateHiddenEntities(rows, ['waitress']);
        expect(shownRows.map(row => row.name)).toEqual(['Rose', 'Tom']);
        expect(hiddenRows.map(row => row.name)).toEqual(['Waitress']);
    });

    it('shows every row with nothing hidden, and ignores a hidden name no row has', () => {
        expect(separateHiddenEntities(rows, ['Nobody'])).toEqual({ shownRows: rows, hiddenRows: [] });
    });
});

describe('isHiddenEntityName and showEntityNameAgain', () => {
    it('find and show again a name hidden in any case', () => {
        const hiddenNames = ['Waitress', 'WAITRESS', 'Tom'];
        expect(isHiddenEntityName(hiddenNames, 'waitress')).toBe(true);
        expect(isHiddenEntityName(hiddenNames, 'Rose')).toBe(false);
        expect(showEntityNameAgain(hiddenNames, 'waitress')).toEqual(['Tom']);
        expect(hiddenNames).toEqual(['Waitress', 'WAITRESS', 'Tom']);
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
