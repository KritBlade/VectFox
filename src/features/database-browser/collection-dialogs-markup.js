/**
 * ============================================================================
 * COLLECTION DIALOGS, MARKUP
 * ============================================================================
 * The forms of a collection's dialogs on GUI-DNA (mvu-helper/devdoc/gui-dna.md):
 * Rename, Switch model, Collection Settings and Manage locks, opened from a
 * collection's row in the Database Browser (collection-dialogs.js). A form is a
 * stack of field genes; each condition rule is a record card. Controls are found
 * by id, a rule's as `vectfox_rule_<index>_<setting>` (ruleControlId), and
 * buttons by data-* hooks: `data-settings-action`, `data-rule-action`,
 * `data-lock-action`. A switch's state is set by the wiring. Every value is
 * escaped by the builders. Pure: builds strings.
 * ============================================================================
 */

import {
    button,
    checkList,
    controlRow,
    emptyState,
    field,
    fieldLabel,
    grid,
    groupTitle,
    hint,
    iconButton,
    input,
    listRow,
    notice,
    recordCard,
    select,
    selectOption,
    stack,
    statusPill,
    textarea,
} from '../../shared/gui-dna/gui-dna-core.js';
import { switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtmlAttribute as escape } from '../../shared/html-escape.js';
import {
    CONDITION_KINDS,
    INJECTION_POSITIONS,
    IN_CHAT_POSITION,
    conditionKindOf,
    effectiveRuleSettings,
    lorebookChoiceLabel,
} from './collection-settings-core.js';

export const RENAME_INPUT_ID = 'vectfox_rename_input';
export const MODEL_SELECT_ID = 'vectfox_model_select';

/** The Collection Settings form's controls and the parts its wiring repaints. */
export const SETTINGS_IDS = {
    lockArea: 'vectfox_settings_lock_area',
    lockSwitch: 'vectfox_always_active',
    triggers: 'vectfox_triggers_input',
    matchMode: 'vectfox_trigger_match_mode',
    scanDepth: 'vectfox_trigger_scan_depth',
    caseSensitive: 'vectfox_trigger_case_sensitive',
    conditionsEnabled: 'vectfox_conditions_enabled',
    logic: 'vectfox_conditions_logic',
    rules: 'vectfox_conditions_list',
    context: 'vectfox_collection_context',
    xmlTag: 'vectfox_collection_xml_tag',
    position: 'vectfox_collection_position',
    depthField: 'vectfox_collection_depth_field',
    depth: 'vectfox_collection_depth',
};

const RULE_CONTROL_ID = /^vectfox_rule_(\d+)_(\w+)$/;

/**
 * The id of one control of a condition rule: its kind, a setting, or the lorebook picker's selects.
 *
 * @param {number} index - The rule's place in the list
 * @param {string} name - `kind`, `lorebook`, `entry`, or the setting's name
 * @returns {string}
 */
export function ruleControlId(index, name) {
    return `vectfox_rule_${index}_${name}`;
}

/**
 * The rule and the control an id of ruleControlId names, or null for any other id.
 *
 * @param {string} id
 * @returns {{index: number, name: string}|null}
 */
export function ruleControlOf(id) {
    const match = RULE_CONTROL_ID.exec(String(id));
    return match ? { index: Number(match[1]), name: match[2] } : null;
}

const option = (value, text, selected) => selectOption({ value, text, isSelected: String(value) === String(selected) });
const dynamicHint = text => `<p class="vfx-hint">${escape(text)}</p>`;
// A saved list setting as a list: an old rule may hold one string.
const asList = value => (Array.isArray(value) ? value : (value ? [String(value)] : []));

/**
 * Rename's form: the name, empty for the automatic one.
 *
 * @param {string} currentName
 * @returns {string}
 */
export function renameFormMarkup(currentName) {
    return stack([field([
        fieldLabel({ text: 'Name', forId: RENAME_INPUT_ID }),
        input({ id: RENAME_INPUT_ID, value: currentName }),
        hint({ text: 'Leave it empty to go back to the automatic name.' }),
    ])]);
}

/**
 * Switch model's form: the collection's embedding models, the one in use chosen.
 *
 * @param {{path: string, name?: string, chunkCount: number}[]} models
 * @param {string} currentPath
 * @returns {string}
 */
export function modelFormMarkup(models, currentPath) {
    const options = models.map(model => selectOption({
        value: model.path,
        name: `${model.name || '(default)'} (${model.chunkCount} ${model.chunkCount === 1 ? 'chunk' : 'chunks'})`,
        isSelected: model.path === currentPath,
    }));
    return stack([field([
        fieldLabel({ text: 'Embedding model', forId: MODEL_SELECT_ID }),
        select({ id: MODEL_SELECT_ID, options }),
        hint({ text: 'Each model keeps its own vectors. VectFox searches the one chosen here.' }),
    ])]);
}

/**
 * The lock area of Collection Settings: the switch for this chat's or character's lock, the lock count and whether
 * one matches here, and Manage locks. The wiring sets the switch's state.
 *
 * @param {{switchState: {title: string, description: string}, summary: {pill: string, isActiveHere: boolean, line: string}}} lock
 * @returns {string}
 */
export function lockAreaMarkup({ switchState, summary }) {
    return switchRow({ id: SETTINGS_IDS.lockSwitch, title: switchState.title, description: switchState.description })
        + controlRow([
            button({ text: 'Manage locks', icon: 'fa-lock', data: { 'settings-action': 'manage-locks' } }),
            statusPill({ name: summary.pill, status: summary.isActiveHere ? 'success' : 'neutral' }),
        ])
        + dynamicHint(summary.line);
}

/**
 * Collection Settings' form: the lock, the activation triggers, the advanced conditions and the prompt context. The
 * wiring sets the three switches.
 *
 * @param {{lock: object, triggersText: string, matchMode: string, scanDepth: number, logic: string, rules: object[],
 *   context: string, xmlTag: string, position: number|null, depth: number|null}} view
 * @param {{worldNames: string[], generationTypes: string[]}} options - For the rules' pickers
 * @returns {string}
 */
export function collectionSettingsMarkup(view, options) {
    const ids = SETTINGS_IDS;
    const isInChat = view.position === IN_CHAT_POSITION;
    return stack([
        groupTitle({ icon: 'fa-lock', text: 'Lock' }),
        `<div id="${ids.lockArea}" class="vfx-stack">${lockAreaMarkup(view.lock)}</div>`,
        groupTitle({ icon: 'fa-bullseye', text: 'Activation triggers' }),
        field([
            fieldLabel({ text: 'Trigger keywords', forId: ids.triggers }),
            textarea({ id: ids.triggers, value: view.triggersText, rows: 4, isCode: true }),
            hint({ text: 'Only turns whose recent messages hold one. One per line or comma-separated.' }),
        ]),
        grid([
            field([
                fieldLabel({ text: 'Match', forId: ids.matchMode }),
                select({ id: ids.matchMode, options: [option('any', 'Any keyword', view.matchMode), option('all', 'Every keyword', view.matchMode)] }),
            ]),
            field([
                fieldLabel({ text: 'Scan depth', forId: ids.scanDepth }),
                input({ id: ids.scanDepth, type: 'number', value: view.scanDepth, min: 1, max: 20, step: 1 }),
                hint({ text: 'Recent messages to read.' }),
            ]),
        ]),
        switchRow({ id: ids.caseSensitive, title: 'Case sensitive', description: 'Keywords match upper and lower case as typed.' }),
        groupTitle({ icon: 'fa-filter', text: 'Advanced conditions' }),
        switchRow({ id: ids.conditionsEnabled, title: 'Use conditions', description: 'Rules that narrow a locked collection further.' }),
        field([
            fieldLabel({ text: 'Logic', forId: ids.logic }),
            select({ id: ids.logic, options: [option('AND', 'Every condition', view.logic), option('OR', 'Any condition', view.logic)] }),
            hint({ text: 'With triggers set too, both must pass.' }),
        ]),
        `<div id="${ids.rules}" class="vfx-stack">${conditionRulesMarkup(view.rules, options)}</div>`,
        `<div>${button({ text: 'Add a condition', icon: 'fa-plus', data: { 'settings-action': 'add-rule' } })}</div>`,
        groupTitle({ icon: 'fa-comment-dots', text: 'Prompt context' }),
        field([
            fieldLabel({ text: 'Context prompt', forId: ids.context }),
            textarea({ id: ids.context, value: view.context, rows: 2 }),
            hint({ text: 'Shown before its chunks. {{user}} and {{char}} work here.' }),
        ]),
        field([
            fieldLabel({ text: 'XML tag', forId: ids.xmlTag }),
            input({ id: ids.xmlTag, value: view.xmlTag, placeholder: 'memories' }),
            hint({ text: 'Wraps its chunks in this tag. Letters, digits, _ and - only.' }),
        ]),
        grid([
            field([
                fieldLabel({ text: 'Injection position', forId: ids.position }),
                select({ id: ids.position, options: INJECTION_POSITIONS.map(({ value, label }) => option(value, label, view.position ?? '')) }),
            ]),
            `<div id="${ids.depthField}"${isInChat ? '' : ' hidden'}>${field([
                fieldLabel({ text: 'Depth', forId: ids.depth }),
                input({ id: ids.depth, type: 'number', value: view.depth ?? 2, min: 0, max: 50, step: 1 }),
                hint({ text: 'Messages from the end of the chat.' }),
            ])}</div>`,
        ]),
    ]);
}

/**
 * The condition rules, one record card each, or a line saying there are none.
 *
 * @param {object[]} rules
 * @param {{worldNames: string[], generationTypes: string[]}} options
 * @returns {string}
 */
export function conditionRulesMarkup(rules, options) {
    if (!rules.length) return emptyState({ icon: 'fa-filter', text: 'No conditions yet.' });
    return rules.map((rule, index) => conditionRuleMarkup(rule, index, options)).join('');
}

/**
 * One condition rule: its kind in the header, then NOT and the kind's settings in the body.
 *
 * @param {{type: string, negate?: boolean, settings?: object}} rule
 * @param {number} index
 * @param {{worldNames: string[], generationTypes: string[]}} options
 * @returns {string}
 */
export function conditionRuleMarkup(rule, index, options) {
    const kind = conditionKindOf(rule.type);
    const kindId = ruleControlId(index, 'kind');
    return recordCard({
        icon: kind.icon,
        text: kind.label,
        actions: [iconButton({ icon: 'fa-trash', title: 'Remove this condition', isDanger: true, data: { 'rule-action': 'remove' } })],
        data: { 'condition-rule': index },
        body: grid([
            field([
                fieldLabel({ text: 'Kind', forId: kindId }),
                select({ id: kindId, options: CONDITION_KINDS.map(each => option(each.value, each.label, kind.value)) }),
            ]),
            field([checkList({ items: [{ name: 'Not: passes when it does not hold', isChecked: Boolean(rule.negate), data: { 'rule-check': 'negate' } }] })]),
            `<div class="vfx-span" data-rule-settings>${ruleSettingsMarkup(rule, index, options)}</div>`,
        ]),
    });
}

/**
 * A rule's settings for its kind, each showing what the activation check uses when the rule leaves it out.
 *
 * @param {{type: string, settings?: object}} rule
 * @param {number} index
 * @param {{worldNames: string[], generationTypes: string[]}} options
 * @returns {string}
 */
export function ruleSettingsMarkup(rule, index, { worldNames = [], generationTypes = [] } = {}) {
    const settings = effectiveRuleSettings(rule);
    const id = name => ruleControlId(index, name);
    const labelled = (text, name, control, hintText = '') => field([
        fieldLabel({ text, forId: id(name) }),
        control,
        hintText ? hint({ text: hintText }) : '',
    ]);
    switch (conditionKindOf(rule.type).value) {
        case 'pattern':
            return grid([
                field([
                    fieldLabel({ text: 'Patterns', forId: id('patterns') }),
                    textarea({ id: id('patterns'), value: asList(settings.patterns).join('\n'), rows: 3, isCode: true }),
                    hint({ text: 'One per line. Plain text, or a regex such as /pattern/i.' }),
                ], { isSpan: true }),
                labelled('Match', 'matchMode', select({ id: id('matchMode'), options: [
                    option('any', 'Any pattern', settings.matchMode),
                    option('all', 'Every pattern', settings.matchMode),
                ] })),
                labelled('Scan depth', 'scanDepth', input({ id: id('scanDepth'), type: 'number', value: settings.scanDepth, min: 1, max: 100, step: 1 }), 'Recent messages to read.'),
                labelled('Search in', 'searchIn', select({ id: id('searchIn'), options: [
                    option('all', 'All messages', settings.searchIn),
                    option('user', 'Your messages', settings.searchIn),
                    option('assistant', 'Character messages', settings.searchIn),
                ] })),
                field([checkList({ items: [{ name: 'Case sensitive', isChecked: settings.caseSensitive === true, data: { 'rule-check': 'caseSensitive' } }] })]),
            ]);
        case 'speaker':
        case 'characterPresent':
            return grid([
                labelled('Names', 'values', input({ id: id('values'), value: asList(settings.values).join(', ') }), 'Comma-separated.'),
                labelled('Match', 'matchType', select({ id: id('matchType'), options: [
                    option('any', 'Any name', settings.matchType),
                    option('all', 'Every name', settings.matchType),
                ] })),
            ]);
        case 'messageCount':
        case 'swipeCount':
            return grid([
                labelled('Compare', 'operator', select({ id: id('operator'), options: [
                    option('gte', 'At least', settings.operator),
                    option('lte', 'At most', settings.operator),
                    option('eq', 'Exactly', settings.operator),
                ] })),
                labelled('Count', 'count', input({ id: id('count'), type: 'number', value: settings.count, min: 0, step: 1 })),
            ]);
        case 'isGroupChat':
            return grid([labelled('Chat', 'isGroup', select({ id: id('isGroup'), options: [
                option('true', 'A group chat', String(settings.isGroup)),
                option('false', 'A chat with one character', String(settings.isGroup)),
            ] }))]);
        case 'generationType':
            return grid([field([
                fieldLabel({ text: 'Generation types' }),
                checkList({ items: generationTypes.map(type => ({
                    name: type,
                    isChecked: asList(settings.values).includes(type),
                    data: { 'rule-generation-type': type },
                })) }),
            ], { isSpan: true })]);
        case 'lorebookActive':
            return grid([
                labelled('Lorebook', 'lorebook', select({ id: id('lorebook'), options: [
                    selectOption({ value: '', text: 'Choose a lorebook' }),
                    ...worldNames.map(name => selectOption({ value: name, name })),
                ] })),
                labelled('Entry', 'entry', select({ id: id('entry'), options: [selectOption({ value: '', text: 'The whole lorebook' })] })),
                `<div class="vfx-span">${button({ text: 'Add', icon: 'fa-plus', data: { 'rule-action': 'add-lorebook' } })}</div>`,
                `<div class="vfx-span vfx-stack" data-lorebook-choices>${lorebookChoicesMarkup(asList(settings.values))}</div>`,
            ]);
        case 'timeOfDay':
            return grid([
                labelled('From', 'startTime', `<input type="time" id="${id('startTime')}" class="vfx-input" value="${escape(settings.startTime)}">`),
                labelled('To', 'endTime', `<input type="time" id="${id('endTime')}" class="vfx-input" value="${escape(settings.endTime)}">`,
                    'By the clock on your computer. A window past midnight works.'),
            ]);
        case 'randomChance':
            return grid([labelled('Chance', 'probability', input({ id: id('probability'), type: 'number', value: settings.probability, min: 0, max: 100, step: 1 }), 'Percent of turns it passes.')]);
        default:
            return notice({ status: 'warning', text: 'This VectFox does not know this kind of condition. Saving keeps it as it is.' });
    }
}

/**
 * The lorebooks and entries a Lorebook active rule looks for, each with its remove button.
 *
 * @param {string[]} values - A lorebook's name, or `name:uid` for one entry
 * @returns {string}
 */
export function lorebookChoicesMarkup(values) {
    if (!values.length) return hint({ text: 'No lorebook chosen yet.' });
    return values.map(value => listRow({
        icon: 'fa-book',
        name: lorebookChoiceLabel(value),
        actions: [iconButton({ icon: 'fa-xmark', title: 'Remove', data: { 'rule-action': 'remove-lorebook', 'lorebook-value': value } })],
    })).join('');
}

/**
 * Manage locks' body: the chat locks, then the character locks, each with its remove button, a line on what can be
 * done here, and the button that locks to the open chat or character.
 *
 * @param {ReturnType<import('./collection-settings-core.js').lockDialogView>} view
 * @returns {string}
 */
export function lockDialogMarkup(view) {
    const removeButton = (action, id) => iconButton({ icon: 'fa-trash', title: 'Remove this lock', isDanger: true, data: { 'lock-action': action, 'lock-id': id } });
    const chatRows = view.chats.length
        ? view.chats.map(chat => listRow({
            icon: 'fa-comment',
            name: chat.id,
            pills: chat.isCurrent ? [statusPill({ text: 'This chat', status: 'success' })] : [],
            actions: [removeButton('remove-chat', chat.id)],
        })).join('')
        : emptyState({ icon: 'fa-comments', text: 'No chat locks yet.' });
    const characterRows = view.characters.length
        ? view.characters.map(character => listRow({
            icon: 'fa-user',
            name: character.name,
            pills: character.isCurrent ? [statusPill({ text: 'This character', status: 'success' })] : [],
            actions: [removeButton('remove-character', character.id)],
        })).join('')
        : emptyState({ icon: 'fa-user', text: 'No character locks yet.' });
    return stack([
        groupTitle({ icon: 'fa-comments', text: 'Chat locks' }),
        chatRows,
        dynamicHint(view.chatLine),
        `<div>${button({ text: 'Lock to this chat', icon: 'fa-plus', kind: 'primary', isDisabled: !view.canLockChat, data: { 'lock-action': 'add-chat' } })}</div>`,
        groupTitle({ icon: 'fa-user', text: 'Character locks' }),
        characterRows,
        dynamicHint(view.characterLine),
        `<div>${button({ text: 'Lock to this character', icon: 'fa-plus', kind: 'primary', isDisabled: !view.canLockCharacter, data: { 'lock-action': 'add-character' } })}</div>`,
    ]);
}
