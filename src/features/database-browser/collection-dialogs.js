/**
 * ============================================================================
 * COLLECTION DIALOGS
 * ============================================================================
 * A collection's dialogs, opened from its row in the Database Browser: Rename,
 * Switch model, Collection Settings and Manage locks, each a GUI-DNA form
 * (collection-dialogs-markup.js) in SillyTavern's popup (sillytavern/popup.js).
 * Collection Settings edits a copy of the collection's conditions, so Save
 * writes it and Cancel drops it. Manage locks acts at once, as its buttons say,
 * and opens over Collection Settings, which then shows the locks as they are.
 * Each dialog answers whether it saved anything, so the browser repaints only
 * then.
 * ============================================================================
 */

import {
    getCollectionMeta,
    setCollectionMeta,
    getCollectionTriggers,
    getCollectionConditions,
    setCollectionConditions,
    getCollectionLocks,
    setCollectionLock,
    removeCollectionLock,
    isCollectionLockedToChat,
    getCollectionLockCount,
    getCollectionCharacterLocks,
    setCollectionCharacterLock,
    removeCollectionCharacterLock,
    isCollectionLockedToCharacter,
    getCollectionCharacterLockCount,
    isCollectionActiveForContext,
    VALID_GENERATION_TYPES,
} from '../collections/index.js';
import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { loadWorldInfo, world_names } from '../../sillytavern/world-info.js';
import { formPopup, noticePopup } from '../../sillytavern/popup.js';
import { log } from '../../sillytavern/log.js';
import { selectOption } from '../../shared/gui-dna/gui-dna-core.js';
import {
    MODEL_SELECT_ID,
    RENAME_INPUT_ID,
    SETTINGS_IDS,
    collectionSettingsMarkup,
    conditionRuleMarkup,
    conditionRulesMarkup,
    lockAreaMarkup,
    lockDialogMarkup,
    lorebookChoicesMarkup,
    modelFormMarkup,
    renameFormMarkup,
    ruleControlId,
    ruleControlOf,
} from './collection-dialogs-markup.js';
import {
    IN_CHAT_POSITION,
    lockDialogView,
    lockSummary,
    lockSwitchState,
    parseInjection,
    parseRuleField,
    parseTriggerList,
    sanitizeXmlTag,
} from './collection-settings-core.js';

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
 * The lock area as it stands: what the switch writes, whether it is on here, and the locks in a few words.
 *
 * @param {string} collectionId
 */
function lockAreaView(collectionId) {
    const chatId = getCurrentChatId();
    const characterId = currentCharacterId();
    const hasChat = Boolean(chatId);
    const hasCharacter = characterId !== null;
    const scope = getCollectionMeta(collectionId).scope;
    return {
        scope,
        isOn: isCollectionActiveForContext(collectionId, { chatId, characterId }),
        switchState: lockSwitchState({ isCharacterScope: scope !== 'chat', hasChat, hasCharacter }),
        summary: lockSummary({
            chatLockCount: getCollectionLockCount(collectionId),
            characterLockCount: getCollectionCharacterLockCount(collectionId),
            isLockedToThisChat: hasChat && isCollectionLockedToChat(collectionId, chatId),
            isLockedToThisCharacter: hasCharacter && isCollectionLockedToCharacter(collectionId, characterId),
            isGroupChat: hasChat && !hasCharacter,
        }),
    };
}

/**
 * Edit a collection's settings: its lock here, activation triggers, advanced conditions and prompt context.
 *
 * @param {string} collectionId - Its registry key
 * @param {string} collectionName
 * @returns {Promise<boolean>} Whether settings were saved or a lock changed
 */
export async function editCollectionSettings(collectionId, collectionName) {
    const meta = getCollectionMeta(collectionId);
    const triggerSettings = getCollectionTriggers(collectionId);
    const conditions = structuredClone(getCollectionConditions(collectionId));
    const rules = conditions.rules || [];
    const options = { worldNames: [...(world_names || [])], generationTypes: VALID_GENERATION_TYPES };
    let lock = lockAreaView(collectionId);
    let haveLocksChanged = false;
    const form = elementFrom(collectionSettingsMarkup({
        lock,
        triggersText: (triggerSettings.triggers || []).join('\n'),
        matchMode: triggerSettings.matchMode || 'any',
        scanDepth: triggerSettings.scanDepth || 5,
        logic: conditions.logic || 'AND',
        rules,
        context: meta.context || '',
        xmlTag: meta.xmlTag || '',
        position: meta.position ?? null,
        depth: meta.depth ?? null,
    }, options));
    const control = id => form.querySelector(`#${id}`);
    const setLockSwitch = () => {
        control(SETTINGS_IDS.lockSwitch).checked = lock.isOn;
        control(SETTINGS_IDS.lockSwitch).disabled = lock.switchState.isDisabled;
    };
    setLockSwitch();
    control(SETTINGS_IDS.caseSensitive).checked = triggerSettings.caseSensitive === true;
    control(SETTINGS_IDS.conditionsEnabled).checked = conditions.enabled === true;

    bindSettingsForm(form, { rules, options });
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
    if (isSubmitted) saveCollectionSettings(form, collectionId, { lock, rules });
    const isChanged = isSubmitted || haveLocksChanged;
    if (isChanged) document.dispatchEvent(new CustomEvent('vectfox:collections-updated'));
    return isChanged;
}

/**
 * Write what the Collection Settings form holds.
 *
 * @param {HTMLElement} form
 * @param {string} collectionId
 * @param {{lock: object, rules: object[]}} edited - The lock area as last shown, and the edited rules
 */
function saveCollectionSettings(form, collectionId, { lock, rules }) {
    const control = id => form.querySelector(`#${id}`);
    // The switch writes the lock of the collection's scope, and only when it was moved: shown on for a lock of the
    // other kind, it must not add one of its own.
    const lockSwitch = control(SETTINGS_IDS.lockSwitch);
    if (!lockSwitch.disabled && lockSwitch.checked !== lock.isOn) {
        writeLockHere(collectionId, lock.scope, lockSwitch.checked);
    }
    setCollectionMeta(collectionId, {
        alwaysActive: false,
        triggers: parseTriggerList(control(SETTINGS_IDS.triggers).value),
        triggerMatchMode: control(SETTINGS_IDS.matchMode).value,
        triggerScanDepth: Number.parseInt(control(SETTINGS_IDS.scanDepth).value, 10) || 5,
        triggerCaseSensitive: control(SETTINGS_IDS.caseSensitive).checked,
        context: control(SETTINGS_IDS.context).value,
        xmlTag: sanitizeXmlTag(control(SETTINGS_IDS.xmlTag).value),
        ...parseInjection(control(SETTINGS_IDS.position).value, control(SETTINGS_IDS.depth).value),
    });
    setCollectionConditions(collectionId, {
        enabled: control(SETTINGS_IDS.conditionsEnabled).checked,
        logic: control(SETTINGS_IDS.logic).value,
        rules,
    });
    log.lifecycle(`VectFox Database Browser: settings of ${collectionId} saved`);
}

/**
 * Lock the collection to this chat or this character, by its scope, or take that lock away.
 *
 * @param {string} collectionId
 * @param {string} scope - `chat`, or `character`
 * @param {boolean} isOn
 */
function writeLockHere(collectionId, scope, isOn) {
    if (scope === 'chat') {
        const chatId = getCurrentChatId();
        if (isOn) setCollectionLock(collectionId, chatId);
        else removeCollectionLock(collectionId, chatId);
        return;
    }
    const characterId = String(currentCharacterId());
    if (isOn) setCollectionCharacterLock(collectionId, characterId);
    else removeCollectionCharacterLock(collectionId, characterId);
}

/**
 * Wire the form's condition rules: add and remove, the kind (its settings start over), NOT, each setting, and the
 * Lorebook active picker. Delegated on the form, so a rule painted later answers too.
 *
 * @param {HTMLElement} form
 * @param {{rules: object[], options: object}} editing - The rules being edited, in place
 */
function bindSettingsForm(form, { rules, options }) {
    const $form = $(form);
    const paintRules = () => {
        form.querySelector(`#${SETTINGS_IDS.rules}`).innerHTML = conditionRulesMarkup(rules, options);
    };
    const ruleOf = (element) => {
        const record = element.closest('[data-condition-rule]');
        const index = Number(record.dataset.conditionRule);
        return { record, index, rule: rules[index] };
    };
    const settingsOf = (rule) => {
        rule.settings ??= {};
        return rule.settings;
    };
    // A rule's header and settings follow its kind. They are drawn again from the builder; the Kind select stays, so it
    // keeps the focus.
    const repaint = (record, rule, index, parts) => {
        const fresh = elementFrom(conditionRuleMarkup(rule, index, options));
        for (const part of parts) record.querySelector(part).replaceWith(fresh.querySelector(part));
    };

    $form.on('click', '[data-settings-action="add-rule"]', () => {
        rules.push({ type: 'pattern', negate: false, settings: {} });
        paintRules();
    });
    $form.on('change', `#${SETTINGS_IDS.position}`, function () {
        form.querySelector(`#${SETTINGS_IDS.depthField}`).hidden = Number.parseInt(this.value, 10) !== IN_CHAT_POSITION;
    });
    $form.on('click', '[data-rule-action="remove"]', function () {
        rules.splice(ruleOf(this).index, 1);
        paintRules();
    });
    $form.on('click', '[data-rule-action="add-lorebook"]', function () {
        const { record, index, rule } = ruleOf(this);
        const lorebookSelect = record.querySelector(`#${ruleControlId(index, 'lorebook')}`);
        const entrySelect = record.querySelector(`#${ruleControlId(index, 'entry')}`);
        if (!lorebookSelect.value) {
            toastr.warning('Choose a lorebook first.', 'VectFox');
            return;
        }
        const value = entrySelect.value ? `${lorebookSelect.value}:${entrySelect.value}` : lorebookSelect.value;
        const values = Array.isArray(rule.settings?.values) ? rule.settings.values : [];
        if (!values.includes(value)) settingsOf(rule).values = [...values, value];
        record.querySelector('[data-lorebook-choices]').innerHTML = lorebookChoicesMarkup(settingsOf(rule).values ?? []);
        lorebookSelect.value = '';
        entrySelect.innerHTML = selectOption({ value: '', text: 'The whole lorebook' });
    });
    $form.on('click', '[data-rule-action="remove-lorebook"]', function () {
        const { record, rule } = ruleOf(this);
        const values = Array.isArray(rule.settings?.values) ? rule.settings.values : [];
        settingsOf(rule).values = values.filter(value => value !== this.dataset.lorebookValue);
        record.querySelector('[data-lorebook-choices]').innerHTML = lorebookChoicesMarkup(settingsOf(rule).values);
    });
    $form.on('change', '[data-condition-rule] input, [data-condition-rule] select, [data-condition-rule] textarea', function () {
        const { record, index, rule } = ruleOf(this);
        if (this.dataset.ruleCheck === 'negate') {
            rule.negate = this.checked;
            return;
        }
        if (this.dataset.ruleCheck) {
            settingsOf(rule)[this.dataset.ruleCheck] = this.checked;
            return;
        }
        if (this.dataset.ruleGenerationType !== undefined) {
            settingsOf(rule).values = [...record.querySelectorAll('[data-rule-generation-type]')]
                .filter(box => box.checked).map(box => box.dataset.ruleGenerationType);
            return;
        }
        const ruleControl = ruleControlOf(this.id);
        if (!ruleControl || ruleControl.name === 'entry') return;
        if (ruleControl.name === 'kind') {
            rule.type = this.value;
            rule.settings = {};
            repaint(record, rule, index, ['.vfx-record-header', '[data-rule-settings]']);
            return;
        }
        if (ruleControl.name === 'lorebook') {
            void showLorebookEntries(record, index, this.value);
            return;
        }
        settingsOf(rule)[ruleControl.name] = parseRuleField(ruleControl.name, this.value);
    });
}

/**
 * Fill a Lorebook active rule's entry select with the chosen lorebook's entries. A lorebook whose entries cannot load
 * leaves the whole lorebook to choose, and the console says why.
 *
 * @param {HTMLElement} record
 * @param {number} index
 * @param {string} lorebookName
 */
async function showLorebookEntries(record, index, lorebookName) {
    const entrySelect = record.querySelector(`#${ruleControlId(index, 'entry')}`);
    const wholeLorebook = selectOption({ value: '', text: 'The whole lorebook' });
    entrySelect.innerHTML = wholeLorebook;
    if (!lorebookName) return;
    entrySelect.disabled = true;
    try {
        const lorebook = await loadWorldInfo(lorebookName);
        // A later pick of another lorebook owns the select now.
        if (record.querySelector(`#${ruleControlId(index, 'lorebook')}`)?.value !== lorebookName) return;
        const entries = Object.values(lorebook?.entries || {});
        entrySelect.innerHTML = wholeLorebook + entries.map(entry => selectOption({
            value: entry.uid,
            name: entry.comment || entry.key?.join(', ') || `Entry ${entry.uid}`,
        })).join('');
    } catch (error) {
        log.warn(`VectFox Database Browser: the entries of lorebook "${lorebookName}" could not load:`, error);
    } finally {
        entrySelect.disabled = false;
    }
}

/**
 * Show and change a collection's chat and character locks. Each button acts at once, and the lists repaint.
 *
 * @param {string} collectionId - Its registry key
 * @param {string} collectionName
 * @returns {Promise<boolean>} Whether a lock changed
 */
export async function manageCollectionLocks(collectionId, collectionName) {
    const characters = getContext()?.characters || [];
    const body = document.createElement('div');
    let hasChanged = false;
    const paint = () => {
        body.innerHTML = lockDialogMarkup(lockDialogView({
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
            case 'add-chat': {
                const chatId = getCurrentChatId();
                if (chatId) setCollectionLock(collectionId, chatId);
                break;
            }
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
