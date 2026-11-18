/**
 * ============================================================================
 * COLLECTION DIALOGS, MARKUP
 * ============================================================================
 * The forms of a collection's dialogs on GUI-DNA (mvu-helper/devdoc/gui-dna.md):
 * Rename, Switch model, Collection Settings and Manage locks, opened from a
 * collection's row in the Database Browser (collection-dialogs.js). A form is a
 * stack of field genes. Controls are found by id, and buttons by data-* hooks:
 * `data-settings-action` and `data-lock-action`. A switch's state is set by the
 * wiring. Every value is escaped by the builders. Pure: builds strings.
 * ============================================================================
 */

import {
    button,
    controlRow,
    emptyState,
    field,
    fieldLabel,
    groupTitle,
    hint,
    iconButton,
    input,
    listRow,
    select,
    selectOption,
    stack,
    statusPill,
} from '../../shared/gui-dna/gui-dna-core.js';
import { switchRow } from '../../shared/gui-dna/panel-page-genes.js';
import { escapeHtmlAttribute as escape } from '../../shared/html-escape.js';

export const RENAME_INPUT_ID = 'vectfox_rename_input';
export const MODEL_SELECT_ID = 'vectfox_model_select';

/** The Collection Settings form's controls and the parts its wiring repaints. */
export const SETTINGS_IDS = {
    lockArea: 'vectfox_settings_lock_area',
    lockSwitch: 'vectfox_always_active',
};

const dynamicHint = text => `<p class="vfx-hint">${escape(text)}</p>`;

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
 * The lock area of Collection Settings: the switch for this chat's or character's lock, the count of the locks the
 * collection reads and whether one matches here, the locks of the other kind it never reads, and Manage locks. The
 * wiring sets the switch's state.
 *
 * @param {{switchState: {title: string, description: string},
 *   summary: {pill: string, isActiveHere: boolean, line: string, unreadLine: string|null}}} lock
 * @returns {string}
 */
export function lockAreaMarkup({ switchState, summary }) {
    return switchRow({ id: SETTINGS_IDS.lockSwitch, title: switchState.title, description: switchState.description })
        + controlRow([
            button({ text: 'Manage locks', icon: 'fa-lock', data: { 'settings-action': 'manage-locks' } }),
            statusPill({ name: summary.pill, status: summary.isActiveHere ? 'success' : 'neutral' }),
        ])
        + dynamicHint(summary.line)
        + (summary.unreadLine ? dynamicHint(summary.unreadLine) : '');
}

/**
 * Collection Settings' form: the lock. The wiring sets its switch.
 *
 * @param {{lock: object}} view
 * @returns {string}
 */
export function collectionSettingsMarkup({ lock }) {
    return stack([
        groupTitle({ icon: 'fa-lock', text: 'Lock' }),
        `<div id="${SETTINGS_IDS.lockArea}" class="vfx-stack">${lockAreaMarkup(lock)}</div>`,
    ]);
}

// Each kind of lock, as Manage locks shows it.
const LOCK_KINDS = {
    chat: { title: 'Chat locks', rowIcon: 'fa-comment', titleIcon: 'fa-comments', empty: 'No chat locks yet.', current: 'This chat', add: 'Lock to this chat' },
    character: { title: 'Character locks', rowIcon: 'fa-user', titleIcon: 'fa-user', empty: 'No character locks yet.', current: 'This character', add: 'Lock to this character' },
};

/**
 * Manage locks' body: the locks of the kind the collection reads, each with its remove button, a line on what can be
 * done here and the button that locks to the open chat or character; then, while there are any, the locks of the
 * other kind it never reads, each marked so and with its remove button.
 *
 * @param {ReturnType<import('./collection-settings-core.js').lockDialogView>} view
 * @returns {string}
 */
export function lockDialogMarkup(view) {
    const removeButton = (kind, id) => iconButton({ icon: 'fa-trash', title: 'Remove this lock', isDanger: true, data: { 'lock-action': `remove-${kind}`, 'lock-id': id } });
    const kind = LOCK_KINDS[view.kind];
    const rows = view.locks.length
        ? view.locks.map(lock => listRow({
            icon: kind.rowIcon,
            name: lock.name,
            pills: lock.isCurrent ? [statusPill({ text: kind.current, status: 'success' })] : [],
            actions: [removeButton(view.kind, lock.id)],
        })).join('')
        : emptyState({ icon: kind.titleIcon, text: kind.empty });
    const parts = [
        groupTitle({ icon: kind.titleIcon, text: kind.title }),
        rows,
        dynamicHint(view.line),
        `<div>${button({ text: kind.add, icon: 'fa-plus', isDisabled: !view.canLock, data: { 'lock-action': `add-${view.kind}` } })}</div>`,
    ];
    if (view.unreadLocks.length) {
        const unreadKind = LOCK_KINDS[view.unreadKind];
        parts.push(
            groupTitle({ icon: unreadKind.titleIcon, text: `${unreadKind.title}, not read` }),
            view.unreadLocks.map(lock => listRow({
                icon: unreadKind.rowIcon,
                name: lock.name,
                pills: [statusPill({ text: 'Not read', status: 'warning' })],
                actions: [removeButton(view.unreadKind, lock.id)],
            })).join(''),
            dynamicHint(view.unreadLine),
        );
    }
    return stack(parts);
}
