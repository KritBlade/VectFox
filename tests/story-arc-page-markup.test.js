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
import { STORY_ARC_ELEMENT_ID, storyArcPageMarkup } from '../src/features/eventbase/story-arc-page-markup.js';
import { ENTITY_ROWS_PER_PAGE, entityListMarkup } from '../src/features/eventbase/story-arc-entity-ui.js';

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
    ])('holds the control %s', (id) => {
        expect(markup).toContain(`id="${id}"`);
    });

    it('offers the Block size slider from 0.4 to 1.0 on the Main tab, beside the number that owns its value', () => {
        const mainPanel = markup.slice(markup.indexOf('data-story-arc-panel="main"'), markup.indexOf('data-story-arc-panel="entity"'));
        const range = /<input type="range" class="vfx-range" data-vfx-slider-for="VectFox_story_arc_block_scale"[^>]*>/.exec(mainPanel)?.[0];
        expect(range).toContain('min="0.4"');
        expect(range).toContain('max="1.0"');
        expect(range).toContain('step="0.05"');
        const box = /<input type="number" id="VectFox_story_arc_block_scale"[^>]*>/.exec(mainPanel)?.[0];
        expect(box).toContain('min="0.4"');
        expect(box).toContain('max="1.0"');
    });

    it('holds every element the page paints', () => {
        for (const id of Object.values(STORY_ARC_ELEMENT_ID)) expect(markup).toContain(`id="${id}"`);
    });

    it('has the Main and Entity tabs', () => {
        expect(markup).toContain('data-story-arc-tab="main"');
        expect(markup).toContain('data-story-arc-panel="entity"');
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
});
