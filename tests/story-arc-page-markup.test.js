/**
 * Tests for the StoryArc page's markup (src/features/eventbase/story-arc-page-markup.js and story-arc-entity-ui.js).
 *
 * Guards that:
 *   - the page holds every control the settings handlers find by id, so moving them to the page kept their wiring,
 *   - the story web has each action its handlers read,
 *   - only the DNA's own classes, state classes and Font Awesome icons are used,
 *   - the entity list pages, opens one panel under its row, and escapes names.
 */

import { describe, it, expect } from 'vitest';
import {
    STORY_ARC_ELEMENT_ID, linkEstimateText, linkPassChoices, storyArcPageMarkup, storyLinkPill, storyLinkStatusMarkup,
} from '../src/features/eventbase/story-arc-page-markup.js';
import { estimateStoryLinkPass } from '../src/features/eventbase/story-arc-links-core.js';
import { ENTITY_ROWS_PER_PAGE, entityListMarkup, hiddenNamesButton } from '../src/features/eventbase/story-arc-entity-ui.js';

const rowsOf = count => Array.from({ length: count }, (_, place) => ({ name: `Name ${place}`, otherNames: [], eventCount: count - place }));
const listParams = { kind: 'people', pageIndex: 0, mergingName: null, splittingName: null, nameChoices: [] };

describe('storyArcPageMarkup', () => {
    const markup = storyArcPageMarkup();

    it('does not say StoryArc needs AgentMode', () => {
        expect(markup).not.toContain('VectFox_story_arc_needs_agent_mode');
        expect(markup).not.toContain('AgentMode');
    });

    it('says the link model also routes each message', () => {
        expect(markup).toContain('Adds one small LLM call per message, on the link model. Needs Qdrant.');
    });

    it.each(['find', 'clear', 'back', 'pause', 'reload'])('holds the story web action %s', (action) => {
        expect(markup).toContain(`data-web-action="${action}"`);
    });

    it.each([
        'VectFox_story_arc_mode_enabled',
        'VectFox_story_arc_link_provider',
        'VectFox_story_arc_link_model',
        'VectFox_story_arc_regenerate_links',
        'VectFox_story_arc_link_status',
        'VectFox_story_arc_link_pill',
        'VectFox_story_arc_debug',
        'VectFox_story_arc_block_scale',
        'VectFox_story_arc_max_tokens',
    ])('holds the control %s', (id) => {
        expect(markup).toContain(`id="${id}"`);
    });

    it('offers the Block size slider from 0.4 to 1.0 on the Main tab, beside the number that owns its value', () => {
        const mainPanel = markup.slice(markup.indexOf('data-story-arc-panel="main"'), markup.indexOf('data-story-arc-panel="linkgraph"'));
        const range = /<input type="range" class="vfx-range" data-vfx-slider-for="VectFox_story_arc_block_scale"[^>]*>/.exec(mainPanel)?.[0];
        expect(range).toContain('min="0.4"');
        expect(range).toContain('max="1.0"');
        expect(range).toContain('step="0.05"');
        const box = /<input type="number" id="VectFox_story_arc_block_scale"[^>]*>/.exec(mainPanel)?.[0];
        expect(box).toContain('min="0.4"');
        expect(box).toContain('max="1.0"');
    });

    it('offers the Max tokens slider from 1,000 to 32,000 on the Main tab, right under Block size', () => {
        const mainPanel = markup.slice(markup.indexOf('data-story-arc-panel="main"'), markup.indexOf('data-story-arc-panel="linkgraph"'));
        const range = /<input type="range" class="vfx-range" data-vfx-slider-for="VectFox_story_arc_max_tokens"[^>]*>/.exec(mainPanel)?.[0];
        expect(range).toContain('min="1000"');
        expect(range).toContain('max="32000"');
        expect(range).toContain('step="500"');
        expect(mainPanel).toContain('id="VectFox_story_arc_max_tokens"');
        expect(mainPanel.indexOf('id="VectFox_story_arc_block_scale"')).toBeLessThan(mainPanel.indexOf('id="VectFox_story_arc_max_tokens"'));
        expect(mainPanel.indexOf('id="VectFox_story_arc_max_tokens"')).toBeLessThan(mainPanel.indexOf('id="VectFox_story_arc_debug"'));
    });

    it('holds every element the page paints', () => {
        for (const id of Object.values(STORY_ARC_ELEMENT_ID)) expect(markup).toContain(`id="${id}"`);
    });

    it('has the Main, LinkGraph and Entity tabs, in that order, with the story web on LinkGraph', () => {
        const tabs = [...markup.matchAll(/data-story-arc-tab="([^"]+)"/g)].map(match => match[1]);
        expect(tabs).toEqual(['main', 'linkgraph', 'entity']);
        const linkGraphPanel = markup.slice(markup.indexOf('data-story-arc-panel="linkgraph"'), markup.indexOf('data-story-arc-panel="entity"'));
        expect(linkGraphPanel).toContain(`id="${STORY_ARC_ELEMENT_ID.webCanvas}"`);
        const mainPanel = markup.slice(markup.indexOf('data-story-arc-panel="main"'), markup.indexOf('data-story-arc-panel="linkgraph"'));
        expect(mainPanel).not.toContain(`id="${STORY_ARC_ELEMENT_ID.webCanvas}"`);
    });

    it('uses only its own classes, state classes and Font Awesome icons', () => {
        const classes = [...markup.matchAll(/class="([^"]*)"/g)].flatMap(match => match[1].split(/\s+/)).filter(Boolean);
        const strangers = classes.filter(name => !/^(vfx-|is-|fa-)/.test(name));
        expect(strangers).toEqual([]);
    });
});

describe('entityListMarkup', () => {
    it('shows one page of rows and a pager', () => {
        const { list, pagerMarkup } = entityListMarkup({ ...listParams, rows: rowsOf(ENTITY_ROWS_PER_PAGE + 1) });
        expect(list).toContain('Name 0');
        expect(list).not.toContain(`Name ${ENTITY_ROWS_PER_PAGE}<`);
        expect(pagerMarkup).toContain('1 / 2');
    });

    it('draws no pager for one page', () => {
        expect(entityListMarkup({ ...listParams, rows: rowsOf(2) }).pagerMarkup).toBe('');
    });

    it('holds a page past the end at the last page', () => {
        const { pageIndex, list } = entityListMarkup({ ...listParams, rows: rowsOf(ENTITY_ROWS_PER_PAGE + 1), pageIndex: 7 });
        expect(pageIndex).toBe(1);
        expect(list).toContain(`Name ${ENTITY_ROWS_PER_PAGE}<`);
    });

    it('says so when nothing is left', () => {
        expect(entityListMarkup({ ...listParams, rows: [] }).list).toContain('No names here.');
    });

    it('offers Split only on a merged entity', () => {
        const merged = [{ name: 'Rose', otherNames: ['Rosie', 'Rosa'], eventCount: 3 }];
        expect(entityListMarkup({ ...listParams, rows: merged }).list).toContain('data-entity-action="split"');
        expect(entityListMarkup({ ...listParams, rows: rowsOf(1) }).list).not.toContain('data-entity-action="split"');
    });

    it('shows other names as written', () => {
        const merged = [{ name: 'Rose', otherNames: ['Rosie', 'Rosa'], eventCount: 3 }];
        expect(entityListMarkup({ ...listParams, rows: merged }).list).toContain('Rosie · Rosa');
    });

    it('opens the Merge panel under its row, offering other names', () => {
        const { list } = entityListMarkup({ ...listParams, rows: rowsOf(2), mergingName: 'Name 0', nameChoices: ['Name 0', 'Name 1'] });
        expect(list).toContain('data-entity-action="merge-confirm"');
        expect(list.indexOf('merge-confirm')).toBeLessThan(list.indexOf('>Name 1<'));
        expect(list).toContain('<option value="Name 1">');
        expect(list).not.toContain('<option value="Name 0">');
    });

    it('opens the Split panel with the row\'s other names', () => {
        const merged = [{ name: 'Rose', otherNames: ['Rosie'], eventCount: 1 }];
        const { list } = entityListMarkup({ ...listParams, rows: merged, splittingName: 'Rose' });
        expect(list).toContain('data-entity-action="split-confirm"');
        expect(list).toContain('value="Rosie"');
    });

    it('escapes a name', () => {
        const { list } = entityListMarkup({ ...listParams, rows: [{ name: '<i>Rose</i>', otherNames: [], eventCount: 1 }] });
        expect(list).not.toContain('<i>Rose</i>');
        expect(list).toContain('&lt;i&gt;Rose&lt;/i&gt;');
    });

    it('offers Hide on every row', () => {
        const { list } = entityListMarkup({ ...listParams, rows: rowsOf(2) });
        expect(list.match(/data-entity-action="hide"/g)).toHaveLength(2);
        expect(list).not.toContain('data-entity-action="unhide"');
    });

    it('lists hidden names with Show again only, under a notice, and opens no panel', () => {
        const merged = [{ name: 'Rose', otherNames: ['Rosie'], eventCount: 2 }];
        const { list } = entityListMarkup({ ...listParams, rows: merged, isShowingHidden: true, mergingName: 'Rose' });
        expect(list).toContain('data-entity-action="unhide"');
        expect(list).toContain('Show again');
        expect(list).toContain('StoryArc still reads them in every search.');
        expect(list).toContain('Rosie');
        for (const action of ['merge', 'split', 'hide', 'merge-confirm']) expect(list).not.toContain(`data-entity-action="${action}"`);
    });
});

describe('hiddenNamesButton', () => {
    it('is not there while the kind hides no name', () => {
        expect(hiddenNamesButton({ isShowingHidden: false, hasHiddenNames: false })).toBe('');
    });

    it('says Show hidden on the list, and Back to names on the hidden list, both as the one toggle', () => {
        const toList = hiddenNamesButton({ isShowingHidden: false, hasHiddenNames: true });
        const back = hiddenNamesButton({ isShowingHidden: true, hasHiddenNames: true });
        expect(toList).toContain('Show hidden');
        expect(back).toContain('Back to names');
        for (const markup of [toList, back]) expect(markup).toContain('data-entity-action="toggle-hidden"');
    });
});

describe('the links line and pill: how far the collection in use is linked', () => {
    const coverage = (decidedCount, totalCount = 12, linkedCount = Math.max(0, decidedCount - 2)) => ({
        collectionName: 'Harbor <b>Keeper</b> 3',
        totalCount,
        decidedCount,
        linkedCount,
        isMostlyDecided: decidedCount >= totalCount * 0.9,
        hasUsableLinks: linkedCount > 0 && decidedCount >= totalCount * 0.9,
    });

    it('is green with every event decided', () => {
        const line = storyLinkStatusMarkup(coverage(12));
        expect(line).toContain('vfx-result-line is-success');
        expect(line).toContain('12 of 12 events decided, 10 with links. StoryArc follows threads through these links.');
        expect(line).not.toContain('Regenerate links');
        expect(storyLinkPill(coverage(12))).toEqual({ status: 'success', text: '12 of 12 events decided' });
    });

    it('is yellow with some decided, for Regenerate links to catch up', () => {
        const line = storyLinkStatusMarkup(coverage(8));
        expect(line).toContain('vfx-result-line is-warning');
        expect(line).toContain('8 of 12 events decided, 6 with links. StoryArc searches without links until 90% of events are decided.'
            + ' Regenerate links catches up the events not decided.');
        expect(storyLinkPill(coverage(8))).toEqual({ status: 'warning', text: '8 of 12 events decided' });
    });

    // A small collection's one call can find nothing to link: its pass is done, so the line must not say it is under way.
    it('says why there are no links with every event decided and none linked', () => {
        const line = storyLinkStatusMarkup(coverage(2, 2, 0));
        expect(line).toContain('vfx-result-line is-success');
        expect(line).toContain('2 of 2 events decided, 0 with links. No event links to an earlier one yet, so StoryArc searches without links.');
    });

    it('counts one event as one', () => {
        expect(storyLinkPill(coverage(0, 1))).toEqual({ status: 'danger', text: '0 of 1 event decided' });
        expect(storyLinkStatusMarkup(coverage(1, 1, 0))).toContain('1 of 1 event decided, 0 with links.');
    });

    it('is red with none decided, as a new collection is until Regenerate links links it', () => {
        const line = storyLinkStatusMarkup(coverage(0));
        expect(line).toContain('vfx-result-line is-danger');
        expect(line).toContain('0 of 12 events decided, 0 with links. StoryArc searches without links until Regenerate links links them, after showing the cost.');
        expect(storyLinkPill(coverage(0))).toEqual({ status: 'danger', text: '0 of 12 events decided' });
    });

    it('names the collection as text', () => {
        expect(storyLinkStatusMarkup(coverage(12))).toContain('&quot;Harbor &lt;b&gt;Keeper&lt;/b&gt; 3&quot;: 12 of 12');
    });

    it('says why, uncoloured, with no collection to read', () => {
        const line = storyLinkStatusMarkup({ problem: 'No collection is in use in this chat, so StoryArc has no events or links here.' });
        expect(line).toContain('No collection is in use in this chat, so StoryArc has no events or links here.');
        expect(line).not.toMatch(/is-(success|warning|danger)/);
    });
});

describe("Regenerate links' choices", () => {
    it('offers Link with none decided', () => {
        expect(linkPassChoices({ undecidedCount: 12, decidedCount: 0, totalCount: 12 })).toEqual([{ text: 'Link 12 events', value: 'undecided' }]);
    });

    it('offers Catch up beside Relink all with some decided', () => {
        expect(linkPassChoices({ undecidedCount: 4, decidedCount: 11, totalCount: 15 })).toEqual([
            { text: 'Catch up 4 events', value: 'undecided' },
            { text: 'Relink all 15 events', value: 'all' },
        ]);
    });

    it('offers Relink all alone with every one decided', () => {
        expect(linkPassChoices({ undecidedCount: 0, decidedCount: 11, totalCount: 11 })).toEqual([{ text: 'Relink all 11 events', value: 'all' }]);
    });

    // A turn synced with StoryArc mode off leaves one new event for Catch up.
    it('counts one event as one', () => {
        expect(linkPassChoices({ undecidedCount: 1, decidedCount: 2, totalCount: 3 })).toEqual([
            { text: 'Catch up 1 event', value: 'undecided' },
            { text: 'Relink all 3 events', value: 'all' },
        ]);
        expect(linkPassChoices({ undecidedCount: 1, decidedCount: 0, totalCount: 1 })).toEqual([{ text: 'Link 1 event', value: 'undecided' }]);
    });
});

describe("Regenerate links' cost line", () => {
    it('counts one event and one minute as one, and shows output under a thousand tokens to the hundred', () => {
        expect(linkEstimateText(estimateStoryLinkPass(1, null, 3))).toBe('1 event: price unknown, about 1 minute, about 2k input and 300 output tokens');
    });

    it('shows thousands from 950 tokens', () => {
        expect(linkEstimateText(estimateStoryLinkPass(3, null, 3))).toBe('3 events: price unknown, about 1 minute, about 5k input and 1k output tokens');
    });

    it('shows the price and the minutes of a larger pass', () => {
        expect(linkEstimateText(estimateStoryLinkPass(15, { input: 0.000001, output: 0.000004 }, 1)))
            .toBe('15 events: about $0.05, about 2 minutes, about 27k input and 5k output tokens');
    });
});
