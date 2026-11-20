/**
 * ============================================================================
 * COLLECTION DIALOGS
 * ============================================================================
 * A collection's dialogs, opened from its row in the Database Browser: Rename,
 * Switch model, Collection Settings and Manage locks, each a GUI-DNA form
 * (collection-dialogs-markup.js) in SillyTavern's popup (sillytavern/popup.js).
 * Collection Settings' lock switch is written on Save and dropped on Cancel.
 * Manage locks acts at once, as its buttons say, and opens over Collection
 * Settings, which then shows the locks as they are. Both offer and count the
 * kind of lock the collection's scope reads (collection-settings-core.js).
 * Each dialog answers whether it saved anything, so the browser repaints only
 * then.
 * ============================================================================
 */

import {
    getCollectionMeta,
    setCollectionMeta,
    getCollectionLocks,
    removeCollectionLock,
    isCollectionLockedToChat,
    getCollectionLockCount,
    getCollectionCharacterLocks,
    setCollectionCharacterLock,
    removeCollectionCharacterLock,
    isCollectionLockedToCharacter,
    getCollectionCharacterLockCount,
    isCollectionActiveForContext,
} from '../collections/index.js';
import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { lockCollectionToOpenChat } from '../eventbase/index.js';
import { formPopup, noticePopup } from '../../sillytavern/popup.js';
import { log } from '../../sillytavern/log.js';
import {
    MODEL_SELECT_ID,
    RENAME_INPUT_ID,
    SETTINGS_IDS,
    collectionSettingsMarkup,
    lockAreaMarkup,
    lockDialogMarkup,
    modelFormMarkup,
    renameFormMarkup,
} from './collection-dialogs-markup.js';
import { lockDialogView, lockSummary, lockSwitchState } from './collection-settings-core.js';

/** An element built from markup with one root. */
function elementFrom(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

/** The open character's id, or null in a group chat or with no chat open. Character 0 is a character. */
function currentCharacterId() {
    const id = getContext()?.characterId;
    return id === undefined || id === null || id === '' ? null : id;
}

/**
 * Rename a collection, or give it back its automatic name when the box is left empty. A name left as it was saves
 * nothing, so an automatic name is never kept as a typed one.
 *
 * @param {string} collectionId - Its registry key
 * @param {string} currentName
 * @returns {Promise<boolean>} Whether a name was saved
 */
export async function renameCollection(collectionId, currentName) {
    const form = elementFrom(renameFormMarkup(currentName));
    const isSubmitted = await formPopup([
        { text: 'Rename the collection' },
        { text: 'Now:', name: currentName },
    ], form, { okButton: 'Rename', focusSelector: `#${RENAME_INPUT_ID}`, isSubmittedOnEnter: true });
    if (!isSubmitted) return false;
    const name = form.querySelector(`#${RENAME_INPUT_ID}`).value.trim();
    if (name === currentName) return false;
    setCollectionMeta(collectionId, { displayName: name || null });
    log.lifecycle(`VectFox Database Browser: ${collectionId} ${name ? `renamed to "${name}"` : 'given back its automatic name'}`);
    return true;
}

/**
 * Choose which of a collection's embedding models VectFox searches.
 *
 * @param {{registryKey?: string, id: string, name: string, model: string, chunkCount: number,
 *   models: {path: string, name?: string, chunkCount: number}[]}} collection
 * @returns {Promise<boolean>} Whether the model changed
 */
export async function switchCollectionModel(collection) {
    const form = elementFrom(modelFormMarkup(collection.models, collection.model));
    const isSubmitted = await formPopup([
        { text: 'Switch the embedding model' },
        { text: 'Collection:', name: collection.name },
    ], form, { okButton: 'Switch' });
    if (!isSubmitted) return false;
    const modelPath = form.querySelector(`#${MODEL_SELECT_ID}`).value;
    if (modelPath === collection.model) return false;
    collection.model = modelPath;
    const model = collection.models.find(each => each.path === modelPath);
    if (model) collection.chunkCount = model.chunkCount;
    setCollectionMeta(collection.registryKey || collection.id, { preferredModel: modelPath });
    log.lifecycle(`VectFox Database Browser: ${collection.id} now searches model "${modelPath || '(default)'}"`);
    return true;
}

/**
 * The lock area as it stands: what the switch writes, whether it is on here, and the locks in a few words, all by
 * the kind of lock the collection's scope reads.
 *
 * @param {string} collectionId
 */
function lockAreaView(collectionId) {
    const chatId = getCurrentChatId();
    const characterId = currentCharacterId();
    const hasChat = Boolean(chatId);
    const hasCharacter = characterId !== null;
    const scope = getCollectionMeta(collectionId).scope;
    const isCharacterScope = scope !== 'chat';
    return {
        scope,
        isOn: isCollectionActiveForContext(collectionId, { chatId, characterId }),
        switchState: lockSwitchState({ isCharacterScope, hasChat, hasCharacter }),
        summary: lockSummary({
            isCharacterScope,
            chatLockCount: getCollectionLockCount(collectionId),
            characterLockCount: getCollectionCharacterLockCount(collectionId),
            isLockedToThisChat: hasChat && isCollectionLockedToChat(collectionId, chatId),
            isLockedToThisCharacter: hasCharacter && isCollectionLockedToCharacter(collectionId, characterId),
            isGroupChat: hasChat && !hasCharacter,
        }),
    };
}

/**
 * Edit a collection's settings: its lock here.
 *
 * @param {string} collectionId - Its registry key
 * @param {string} collectionName
 * @returns {Promise<boolean>} Whether the lock switch was saved or a lock changed
 */
export async function editCollectionSettings(collectionId, collectionName) {
    let lock = lockAreaView(collectionId);
    let haveLocksChanged = false;
    const form = elementFrom(collectionSettingsMarkup({ lock }));
    const control = id => form.querySelector(`#${id}`);
    const setLockSwitch = () => {
        control(SETTINGS_IDS.lockSwitch).checked = lock.isOn;
        control(SETTINGS_IDS.lockSwitch).disabled = lock.switchState.isDisabled;
    };
    setLockSwitch();

    $(form).on('click', '[data-settings-action="manage-locks"]', async () => {
        haveLocksChanged = (await manageCollectionLocks(collectionId, collectionName)) || haveLocksChanged;
        lock = lockAreaView(collectionId);
        control(SETTINGS_IDS.lockArea).innerHTML = lockAreaMarkup(lock);
        setLockSwitch();
    });

    const isSubmitted = await formPopup([
        { text: 'Collection settings' },
        { text: 'Collection:', name: collectionName },
    ], form, { okButton: 'Save', isWide: true });
    if (isSubmitted) saveCollectionSettings(form, collectionId, lock);
    const isChanged = isSubmitted || haveLocksChanged;
    if (isChanged) document.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
    return isChanged;
}

/**
 * Write what the Collection Settings form holds: the lock switch, which writes the lock of the collection's scope, and
 * only when it was moved: shown on for a lock of the other kind, it must not add one of its own.
 *
 * @param {HTMLElement} form
 * @param {string} collectionId
 * @param {object} lock - The lock area as last shown
 */
function saveCollectionSettings(form, collectionId, lock) {
    const lockSwitch = form.querySelector(`#${SETTINGS_IDS.lockSwitch}`);
    if (lockSwitch.disabled || lockSwitch.checked === lock.isOn) return;
    writeLockHere(collectionId, lock.scope, lockSwitch.checked);
    log.lifecycle(`VectFox Database Browser: the lock of ${collectionId} saved`);
}

/**
 * Lock the collection to this chat or this character, by its scope, or take that lock away. A chat lock on one of the
 * chat's own EventBase collections puts it in use there, unlocking the chat's others (lockCollectionToOpenChat).
 *
 * @param {string} collectionId
 * @param {string} scope - `chat`, or `character`
 * @param {boolean} isOn
 */
function writeLockHere(collectionId, scope, isOn) {
    if (scope === 'chat') {
        if (isOn) lockCollectionToOpenChat(collectionId);
        else removeCollectionLock(collectionId, getCurrentChatId());
        return;
    }
    const characterId = String(currentCharacterId());
    if (isOn) setCollectionCharacterLock(collectionId, characterId);
    else removeCollectionCharacterLock(collectionId, characterId);
}

/**
 * Show and change a collection's locks: those of the kind its scope reads, and add one here; and remove a lock of the
 * other kind saved before, which it never reads. Each button acts at once, and the lists repaint.
 *
 * @param {string} collectionId - Its registry key
 * @param {string} collectionName
 * @returns {Promise<boolean>} Whether a lock changed
 */
export async function manageCollectionLocks(collectionId, collectionName) {
    const characters = getContext()?.characters || [];
    const isCharacterScope = getCollectionMeta(collectionId).scope !== 'chat';
    const body = document.createElement('div');
    let hasChanged = false;
    const paint = () => {
        body.innerHTML = lockDialogMarkup(lockDialogView({
            isCharacterScope,
            chatLocks: getCollectionLocks(collectionId),
            characterLocks: getCollectionCharacterLocks(collectionId),
            chatId: getCurrentChatId(),
            characterId: currentCharacterId(),
            characterNameOf: id => characters[id]?.data?.name || characters[id]?.name || `Character ${id}`,
        }));
    };
    paint();
    $(body).on('click', '[data-lock-action]', function () {
        const lockId = this.dataset.lockId;
        switch (this.dataset.lockAction) {
            case 'add-chat':
                lockCollectionToOpenChat(collectionId);
                break;
            case 'add-character': {
                const characterId = currentCharacterId();
                if (characterId !== null) setCollectionCharacterLock(collectionId, String(characterId));
                break;
            }
            case 'remove-chat':
                removeCollectionLock(collectionId, lockId);
                break;
            case 'remove-character':
                removeCollectionCharacterLock(collectionId, lockId);
                break;
        }
        hasChanged = true;
        paint();
    });
    await noticePopup([
        { text: 'Manage locks' },
        { text: 'Collection:', name: collectionName },
    ], { body });
    return hasChanged;
}
