/**
 * LoreBase's review (plan §5.6 and D6 of InternalProject/Vectfox/plans/executed/lorebook-semantic-overhaul-passage-index.md):
 * GPT-6 Luna reads one picked entry's text, cut into numbered parts, and says how much of it the next reply will use
 * and which parts are of no use for the moment. Each picked entry has its own call, showing it alone as entry 1, at
 * low reasoning effort, with one prompt: the route trials' review_topic_cuts_lean word for word (InternalProject/
 * Vectfox/tools/lorebase-benchmark/route_trials.py); tests/lorebase-pick-and-review.test.js holds it to the trials'
 * own rendering. Pure: no SillyTavern, no network.
 */
import { chatHead } from './lorebase-scene-core.js';
import { INTRO_SECTION } from './lorebase-splitter.js';

const REVIEW_SYSTEM_PROMPT = 'You check the lorebook entries a roleplay app picked for its next reply, now that you can read their text. '
    + 'Treat the world as one you do not know: use only what the chat and the entries say. Return JSON only.';

const REVIEW_LEAD = "You picked these lorebook entries for the next reply from the lorebook's table of contents, which shows only their titles. "
    + 'Each comes with the reason you gave and its text, cut into numbered parts.';

const REVIEW_INSTRUCTIONS = [
    'For each entry, answer:',
    '- uses: how much of its text the next reply will use: "most", "some" or "none";',
    '- leave_out: the numbers of the parts of no use for this moment: those not about the people, place or topic at hand;',
    'Return {"entries": [{"entry": <number>, "uses": "...", "leave_out": [<number>, ...]}, ...]}',
].join('\n');

const USES = ['most', 'some', 'none'];

// An entry with template code is sent whole, never trimmed (D9).
const TEMPLATE_CODE_OPENER = '<%';

/**
 * Whether text holds template code, which LoreBase never trims (D9).
 * @param {string} text
 * @returns {boolean}
 */
export function hasTemplateCode(text) {
    return String(text ?? '').includes(TEMPLATE_CODE_OPENER);
}

/**
 * The review's messages for one picked entry: the scene, then the entry alone as entry 1, with the reasons the pick
 * gave and its parts, each numbered and, unless it is the intro, named by its section.
 * @param {string} scene - From sceneText
 * @param {{title: string, why: string, needs: string}} pick - From readPicks
 * @param {Array<{section: string, text: string}>} passages - The entry's parts, from entryPassages
 * @returns {Array<{role: string, content: string}>}
 */
export function reviewMessages(scene, pick, passages) {
    const parts = passages.map((passage, index) => `[${index + 1}] ${passage.section === INTRO_SECTION ? '' : `(${passage.section}) `}${passage.text}`);
    const entry = `Entry 1: ${pick.title}\nYour reason: ${pick.why} You wanted: ${pick.needs}\nIts text:\n${parts.join('\n')}`;
    const prompt = `${chatHead(scene)}${REVIEW_LEAD}\n\n${entry}\n\n${REVIEW_INSTRUCTIONS}`;
    return [{ role: 'system', content: REVIEW_SYSTEM_PROMPT }, { role: 'user', content: prompt }];
}

/**
 * The review's answer for its entry: how much of it the reply uses, and the parts to leave out, each a whole number
 * among the entry's parts, as the trials read them. Null when the answer holds no item for entry 1 whose uses is
 * "most", "some" or "none": an answer that cannot be read, which the turn reports as a failed review (D14, §5.8).
 * @param {unknown[]} items - The answer's entries, as parseJsonArrayFromLlm reads them
 * @param {number} partCount - How many parts the review was shown
 * @returns {{uses: string, leaveOut: number[]}|null}
 */
export function readReview(items, partCount) {
    const answer = items.find(item => String(item?.entry ?? '').trim() === '1');
    const uses = typeof answer?.uses === 'string' ? answer.uses.trim().toLowerCase() : '';
    if (!USES.includes(uses)) return null;
    const listed = Array.isArray(answer.leave_out) ? answer.leave_out : [];
    const leaveOut = new Set(listed.map(part => String(part).trim()).filter(part => /^\d+$/.test(part)).map(Number)
        .filter(part => part >= 1 && part <= partCount));
    return { uses, leaveOut: [...leaveOut].sort((first, second) => first - second) };
}

/**
 * The parts a reviewed pick sends, in the entry's order (§5.6): none when the reply uses none of it; every part when
 * the entry has template code (D9); otherwise every part but those left out, and a pinned section's parts always.
 * @param {Array<{section: string, text: string}>} passages - The entry's parts, from entryPassages
 * @param {{uses: string, leaveOut: number[]}} review - From readReview
 * @param {string[]} pinnedSections - The book's pinned section names (§5.4)
 * @returns {number[]} Part numbers, from 1
 */
export function partsToSend(passages, review, pinnedSections) {
    if (review.uses === 'none') return [];
    const numbers = passages.map((_, index) => index + 1);
    if (passages.some(passage => hasTemplateCode(passage.text))) return numbers;
    const leftOut = new Set(review.leaveOut);
    return numbers.filter(number => !leftOut.has(number) || pinnedSections.includes(passages[number - 1].section));
}
