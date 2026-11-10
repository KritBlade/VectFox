/**
 * ============================================================================
 * COLLECTION SETTINGS, PURE RULES
 * ============================================================================
 * What the Database Browser's collection dialogs (collection-dialogs.js) show and
 * save. Each condition kind carries the value the activation check
 * (collections/conditional-activation.js) uses for a setting a rule leaves out,
 * so the form shows what will run. Also the form's text turned into saved
 * values, the lock switch's wording, the lock summary and the lock dialog's
 * lists. Pure.
 * ============================================================================
 */

import { counted } from './counted.js';

/** Each kind of condition rule, in the order the Kind select lists them. */
export const CONDITION_KINDS = [
    { value: 'pattern', label: 'Pattern match', icon: 'fa-magnifying-glass' },
    { value: 'speaker', label: 'Speaker', icon: 'fa-comment' },
    { value: 'characterPresent', label: 'Character present', icon: 'fa-users' },
    { value: 'messageCount', label: 'Message count', icon: 'fa-hashtag' },
    { value: 'isGroupChat', label: 'Group chat', icon: 'fa-people-group' },
    { value: 'generationType', label: 'Generation type', icon: 'fa-gears' },
    { value: 'lorebookActive', label: 'Lorebook active', icon: 'fa-book' },
    { value: 'swipeCount', label: 'Swipe count', icon: 'fa-hand-pointer' },
    { value: 'timeOfDay', label: 'Time of day', icon: 'fa-clock' },
    { value: 'randomChance', label: 'Random chance', icon: 'fa-dice' },
];

/** The value the activation check uses for each setting a rule of a kind leaves out (conditional-activation.js). */
const CONDITION_DEFAULTS = {
    pattern: { patterns: [], matchMode: 'any', scanDepth: 10, searchIn: 'all', caseSensitive: false },
    speaker: { values: [], matchType: 'any' },
    characterPresent: { values: [], matchType: 'any' },
    messageCount: { count: 0, operator: 'gte' },
    swipeCount: { count: 0, operator: 'gte' },
    isGroupChat: { isGroup: true },
    generationType: { values: ['normal'] },
    lorebookActive: { values: [] },
    timeOfDay: { startTime: '00:00', endTime: '23:59' },
    randomChance: { probability: 50 },
};

/** The lowest and highest value a number setting saves. */
const NUMBER_LIMITS = { count: [0, 100000], probability: [0, 100], scanDepth: [1, 100] };

/**
 * A rule's kind. A rule of the old `keyword` type is a pattern rule: the activation check runs it as one.
 *
 * @param {string} type
 * @returns {{value: string, label: string, icon: string}}
 */
export function conditionKindOf(type) {
    const value = type === 'keyword' ? 'pattern' : type;
    return CONDITION_KINDS.find(kind => kind.value === value) || { value, label: 'Unknown condition', icon: 'fa-circle-question' };
}

/**
 * A rule's settings as the activation check reads them: its own, over the defaults of its kind. A setting saved
 * empty (undefined or null) takes the default, and an old keyword rule's `values` are its patterns.
 *
 * @param {{type: string, settings?: object}} rule
 * @returns {object}
 */
export function effectiveRuleSettings(rule) {
    const kind = conditionKindOf(rule.type).value;
    const own = Object.fromEntries(Object.entries(rule.settings || {}).filter(([, value]) => value !== undefined && value !== null));
    if (kind === 'pattern' && own.patterns === undefined && Array.isArray(own.values)) own.patterns = own.values;
    return { ...(CONDITION_DEFAULTS[kind] || {}), ...own };
}

const splitList = (text, separator) => String(text ?? '').split(separator).map(part => part.trim()).filter(Boolean);

/**
 * One rule setting from the text of its control: patterns one per line, names comma-separated, numbers held to their
 * limits, the group-chat choice as true or false. Anything else is kept as written.
 *
 * @param {string} field - The setting's name
 * @param {string} text - The control's value
 * @returns {*}
 */
export function parseRuleField(field, text) {
    if (field === 'patterns') return splitList(text, '\n');
    if (field === 'values') return splitList(text, ',');
    if (field === 'isGroup') return text === 'true';
    if (field in NUMBER_LIMITS) {
        const [lowest, highest] = NUMBER_LIMITS[field];
        const number = Number.parseInt(text, 10);
        return Number.isFinite(number) ? Math.min(highest, Math.max(lowest, number)) : lowest;
    }
    return text;
}

/**
 * The trigger keywords from their box: one per line or comma-separated.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseTriggerList(text) {
    return splitList(text, /[\n,]/);
}

/**
 * An XML tag as saved: letters, digits, `_` and `-` only.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeXmlTag(text) {
    return String(text ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Where a collection's chunks go in the prompt: its own position, or the global default when it has none. */
export const INJECTION_POSITIONS = [
    { value: '', label: 'Global default' },
    { value: '2', label: 'Before Main Prompt' },
    { value: '0', label: 'After Main Prompt' },
    { value: '1', label: 'In chat at a depth' },
];

/** The position that places chunks in the chat at a depth, which alone saves a depth. */
export const IN_CHAT_POSITION = 1;

const DEFAULT_DEPTH = 2;

/**
 * The injection position and depth from their controls. No position means the global default; a depth is saved only
 * for the in-chat position, 0 to 50, and 2 when its box holds no number.
 *
 * @param {string} positionText
 * @param {string} depthText
 * @returns {{position: number|null, depth: number|null}}
 */
export function parseInjection(positionText, depthText) {
    const position = positionText === '' ? null : Number.parseInt(positionText, 10);
    if (position !== IN_CHAT_POSITION) return { position: Number.isFinite(position) ? position : null, depth: null };
    const depth = Number.parseInt(depthText, 10);
    return { position, depth: Number.isFinite(depth) ? Math.min(50, Math.max(0, depth)) : DEFAULT_DEPTH };
}

/**
 * What the lock switch writes, said on the switch: a character lock or a chat lock, by the collection's scope. Without
 * the chat or character it would lock, the switch is off limits and its line says where to go instead.
 *
 * @param {{isCharacterScope: boolean, hasChat: boolean, hasCharacter: boolean}} context
 * @returns {{title: string, description: string, isDisabled: boolean}}
 */
export function lockSwitchState({ isCharacterScope, hasChat, hasCharacter }) {
    const title = isCharacterScope ? 'Active for this character' : 'Active for this chat';
    if (!hasChat) return { title, description: 'No chat is open. Open one to lock this collection to it.', isDisabled: true };
    if (isCharacterScope && !hasCharacter) {
        return { title, description: 'A group chat has no single character. Use Manage locks to lock this chat.', isDisabled: true };
    }
    return {
        title,
        description: isCharacterScope ? 'On: active in every chat with this character.' : 'On: active in this chat.',
        isDisabled: false,
    };
}

/**
 * A collection's locks in a few words: how many, and whether one matches here. A collection with only character locks
 * never matches in a group chat, which has no single character, so the line says to add a chat lock there.
 *
 * @param {{chatLockCount: number, characterLockCount: number, isLockedToThisChat: boolean,
 *   isLockedToThisCharacter: boolean, isGroupChat: boolean}} locks
 * @returns {{pill: string, isActiveHere: boolean, line: string}}
 */
export function lockSummary({ chatLockCount, characterLockCount, isLockedToThisChat, isLockedToThisCharacter, isGroupChat }) {
    const total = chatLockCount + characterLockCount;
    const isActiveHere = Boolean(isLockedToThisChat || isLockedToThisCharacter);
    const pill = total === 0 ? 'No locks' : counted(total, 'lock');
    if (total === 0) return { pill, isActiveHere, line: 'Not locked, so it never activates.' };
    if (isActiveHere) {
        const here = isLockedToThisChat && isLockedToThisCharacter
            ? 'this chat and this character'
            : isLockedToThisChat ? 'this chat' : 'this character';
        return { pill, isActiveHere, line: `Active here: locked to ${here}.` };
    }
    if (isGroupChat && chatLockCount === 0) {
        return { pill, isActiveHere, line: 'Not active here. A group chat has no single character, so add a chat lock.' };
    }
    return { pill, isActiveHere, line: 'Not active here. Its locks are for other chats or characters.' };
}

/**
 * The lock dialog's two lists and what each section can do here.
 *
 * @param {{chatLocks: string[], characterLocks: Array<string|number>, chatId: string|null,
 *   characterId: string|number|null, characterNameOf: (id: string) => string}} locks
 * @returns {{chats: {id: string, isCurrent: boolean}[], characters: {id: string, name: string, isCurrent: boolean}[],
 *   canLockChat: boolean, chatLine: string, canLockCharacter: boolean, characterLine: string}}
 */
export function lockDialogView({ chatLocks, characterLocks, chatId, characterId, characterNameOf }) {
    const hasChat = Boolean(chatId);
    const hasCharacter = characterId !== null && characterId !== undefined && characterId !== '';
    const chats = chatLocks.map(id => ({ id: String(id), isCurrent: hasChat && String(id) === String(chatId) }));
    const characters = characterLocks.map(id => ({
        id: String(id),
        name: characterNameOf(String(id)),
        isCurrent: hasCharacter && String(id) === String(characterId),
    }));
    const isChatLocked = chats.some(chat => chat.isCurrent);
    const isCharacterLocked = characters.some(character => character.isCurrent);
    let characterLine;
    if (hasCharacter) characterLine = isCharacterLocked ? 'Locked to this character.' : 'Lock it to the open character.';
    else if (hasChat) characterLine = 'A group chat has no single character, so use a chat lock.';
    else characterLine = 'No character is open.';
    return {
        chats,
        characters,
        canLockChat: hasChat && !isChatLocked,
        chatLine: hasChat ? (isChatLocked ? 'Locked to this chat.' : 'Lock it to the open chat.') : 'Open a chat to lock it to one.',
        canLockCharacter: hasCharacter && !isCharacterLocked,
        characterLine,
    };
}

/**
 * A lorebook choice of a Lorebook active rule, for its row: a whole lorebook (`World`), or one entry
 * (`World:12`, the entry's uid after the last colon).
 *
 * @param {string} value
 * @returns {string}
 */
export function lorebookChoiceLabel(value) {
    const text = String(value);
    const colon = text.lastIndexOf(':');
    const uid = colon > 0 ? text.slice(colon + 1) : '';
    return /^\d+$/.test(uid) ? `${text.slice(0, colon)}, entry ${uid}` : text;
}
