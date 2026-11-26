/**
 * ============================================================================
 * ENTITY-LORE, THE RUN
 * ============================================================================
 * Writes a lorebook entry for each named character StoryArc counts often
 * (InternalProject/Vectfox/plans/entity-lore.md §3, §4, §5, §7): after an
 * EventBase run that added events to the open chat's collection in use, at most
 * 5 entries; on Run now, every entry due, once the user says yes; from a row of
 * the Entity-Lore card, one character's entry, new or again. One run at a
 * time: an EventBase run that ends during one runs one more after it. The card
 * reads each character's state as a run reads it, the last run's outcome, and
 * what keeps Entity-Lore from running; its Allow again clears a name's record.
 *
 * A run reads the chat's stored events and the record in the collection's
 * metadata, starts the record over when its book is gone (D13) and marks
 * deleted each entry the user deleted, then asks the name check about every
 * name due, and writes the entries due, new before rewrites, most events
 * first, 3 at a time, on the progress panel. The first entry creates the
 * chat's book and adds it to the chat (D1, D11), only while that chat is open;
 * each new entry joins the selection in use there, and LoreBase writes the
 * book's keys and vectors after the run, on its own panel, or at the next run
 * while it writes others. A rewrite saves through LoreBase's entry save, which
 * writes its vectors, then has its keys written again. The book's saves go one
 * at a time, as each saves a loaded copy of the whole book. Switching chats or
 * Stop ends a run once the entries under way are written.
 * ============================================================================
 */

import { log } from '../../sillytavern/log.js';
import { getContext, getCurrentChatId } from '../../sillytavern/chat.js';
import { eventSource, event_types } from '../../sillytavern/events.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { extension_settings } from '../../sillytavern/settings.js';
import { createLorebook, createLorebookEntry, loadWorldInfo, saveLorebookEntry, world_names } from '../../sillytavern/world-info.js';
import { chatMessages } from '../../shared/chat-messages.js';
import { counted } from '../../shared/counted.js';
import { isInvalidModelConfigError, notifyInvalidModel } from '../../shared/model-config-notifier.js';
import { progressTracker } from '../../shared/progress-tracker.js';
import { getCollectionMeta, setCollectionMeta } from '../collections/index.js';
import {
    buildEntityNameWriter, chineseScriptNameOf, collectionInUse, eventsNamingEntity, formatStoryLine, holdsName, inTimelineOrder,
    isStoryArcActive, listEntities, readChatStoryEvents, readEntityMerges, readStoryLanguage, withKeptEntityNames,
} from '../eventbase/index.js';
import { parseJsonArrayFromLlm } from '../llm-provider/index.js';
import {
    ADD_TO_CHAT, BOTH_KINDS, THINKING_TOKEN_ALLOWANCE, addLoreBookToChat, askTextOnLoreBase, chatBookNames, chatCharacters, ensureLoreSelection,
    estimatedTokens, isLoreBaseSwitchedOn, isLoreBaseWriting, loreBaseInactiveReason, regenerateKeysOfEntries, resolveLoreBaseLlmConfig,
    saveEntryWithVectors, selectionInUse, setLoreBookSelection, setLoreSelectionLock, writeMissing,
} from '../lorebase/index.js';
import {
    ENTITY_LORE_SETTING, ENTITY_STATE, ENTRIES_PER_AUTOMATIC_RUN, RECORD_STATE, dueCounts, entityLoreBlocker as blockerOf, entityLoreStates,
    entriesForName, entriesForRun, entryContentHash, entryKeysOf, isEntityLoreOn, namesMatchedTo, npcBookName, readEntityLoreRecord, recordOfName,
    rewriteEveryEventsOf, runNowQuestion, runOutcomeText, sliceEventLines, withBookName, withBookStartedOver, withEntryForgotten,
    withMissingEntriesDeleted, withNameCheckAnswer, withWrittenEntry, writeAtEventsOf, writtenEntryTitles,
} from './entity-lore-core.js';
import {
    NAME_CHECK_ANSWER, entryMessages, nameCheckMessages, notesMessages, readEntryAnswer, readNameCheck, readNotesAnswer,
} from './entity-lore-prompts.js';

const LOG = '[VectFox-EntityLore]';
const CONTEXT_LABEL = 'Entity-Lore';
// Entries whose calls run at once (§4.1).
const ENTRIES_AT_ONCE = 3;
// How long one call may take: on rabbit, GPT-6 Luna took up to 26 s for an entry or a slice's notes (C2's live check).
const CALL_TIMEOUT_MS = 180000;
// Room for each answer, and for a thinking model to reason before it: the check answers each name in a line, an entry
// is at most 600 words, and a slice's notes ran to 3,943 tokens on rabbit.
const NAME_CHECK_REQUEST = { maxTokens: 2000 + THINKING_TOKEN_ALLOWANCE, reasoningEffort: 'low' };
const ENTRY_REQUEST = { maxTokens: 6000 + THINKING_TOKEN_ALLOWANCE, reasoningEffort: null };

const WRITING_ALREADY = 'Entity-Lore is writing already; the progress panel shows it.';

/** @type {{isStopped: boolean, chatId: string}|null} */
let activeRun = null;
let isRunAgain = false;
/** @type {{chatId: string, text: string, isClean: boolean}|null} */
let lastRun = null;
const runEndedListeners = new Set();

/**
 * What a run writes: the entries it picks from the states, and the due names its name check asks about. A run after an
 * EventBase run and Run now ask about every name due, so the record fills up (§4.3); a row's button about its own.
 * @typedef {{pickFrom: (states: object[]) => object[], dueToCheck: (states: object[]) => object[]}} RunScope
 */
const isDue = each => each.state === ENTITY_STATE.due;
const wholeRun = limit => ({ pickFrom: states => entriesForRun(states, limit), dueToCheck: states => states.filter(isDue) });
const oneNameRun = name => ({ pickFrom: states => entriesForName(states, name), dueToCheck: states => entriesForName(states, name).filter(isDue) });

/**
 * What keeps Entity-Lore from running now, its own switch aside (§3, D8), or null when nothing does: LoreBase not
 * acting, StoryArc mode off, or LoreBase's model not set, each with what to do and where (entityLoreBlocker in
 * entity-lore-core.js). The card shows it; a run is refused with its fix.
 * @param {object} [settings] - VectFox settings, the live ones by default
 * @returns {{need: string, reason: string, fix: string, fixAt: string|null}|null}
 */
export function entityLoreBlocker(settings = extension_settings.vectfox) {
    const connection = resolveLoreBaseLlmConfig(settings);
    return blockerOf({
        loreBaseReason: loreBaseInactiveReason(settings),
        isLoreBaseSwitchedOn: isLoreBaseSwitchedOn(settings),
        isStoryArcActive: isStoryArcActive(settings),
        modelProblem: connection.ok ? null : connection.problem ?? "Set LoreBase's model on the Main tab first.",
    });
}

/**
 * Why Entity-Lore does not run now, or null when it does: its switch on, and nothing else keeping it (entityLoreBlocker).
 * @param {object} settings - VectFox settings
 * @returns {string|null}
 */
function entityLoreProblem(settings) {
    if (!isEntityLoreOn(settings)) return 'Use Entity-Lore is off.';
    return entityLoreBlocker(settings)?.fix ?? null;
}

/**
 * After an EventBase run (§4.1): a run of at most 5 entries when it added events to the open chat's collection in use
 * and Entity-Lore runs; during a run, one more after it.
 * @param {{collectionId: string, eventsAdded: number}} run - What EventBase announces
 */
export function onEventBaseRunEnded({ collectionId, eventsAdded }) {
    const settings = extension_settings.vectfox;
    if (!(eventsAdded > 0) || entityLoreProblem(settings)) return;
    if (collectionInUse(settings).collection?.collectionId !== collectionId) return;
    if (activeRun) {
        isRunAgain = true;
        return;
    }
    void runEntityLore(settings, wholeRun(ENTRIES_PER_AUTOMATIC_RUN));
}

/**
 * Run now (§4.1): every entry due, once the user says yes to how many. During a run, its progress panel comes to the
 * front instead.
 * @returns {Promise<{problem: string|null, isNothingDue?: boolean}>} Why nothing ran, or null when the run ran or the
 *   user said no; isNothingDue when no entry was due, which turning the switch on says nothing of
 */
export async function runEntityLoreNow() {
    const settings = extension_settings.vectfox;
    if (activeRun) {
        progressTracker.reopen();
        return { problem: WRITING_ALREADY };
    }
    const problem = entityLoreProblem(settings);
    if (problem) return { problem };
    const chat = await readChatEntities(settings);
    if (chat.problem) return { problem: chat.problem };
    const counts = dueCounts(chat.states);
    if (!counts.newCount && !counts.rewriteCount) return { problem: 'No entry is due now.', isNothingDue: true };
    if (!await confirmPopup([{ icon: 'fa-users-viewfinder', text: runNowQuestion(counts) }], { okButton: 'Write' })) return { problem: null };
    await runEntityLore(settings, wholeRun(Number.POSITIVE_INFINITY));
    return { problem: null };
}

/**
 * A row's Write now, Rewrite now or Rewrite anyway (§3): one character's entry, new after the name check on that name,
 * or again, due or not, from the entry as it stands, as the user left it for one they edited (D4). Nothing for a row in
 * another state. During a run, its progress panel comes to the front instead.
 * @param {string} name - The row's kept name
 * @returns {Promise<{problem: string|null}>} Why nothing ran, or null once the run ended
 */
export async function writeEntityLoreEntryNow(name) {
    const settings = extension_settings.vectfox;
    if (activeRun) {
        progressTracker.reopen();
        return { problem: WRITING_ALREADY };
    }
    const problem = entityLoreProblem(settings);
    if (problem) return { problem };
    await runEntityLore(settings, oneNameRun(name));
    return { problem: null };
}

/**
 * Allow again (§3, §6): the open chat's record forgets a kept name, so it is counted as if new, due at Write at and
 * asked about by the next name check. Refused while a run writes, as the run saves the record it read.
 * @param {string} name - The row's kept name
 * @returns {{problem: string|null}}
 */
export function allowEntityLoreAgain(name) {
    if (activeRun) return { problem: WRITING_ALREADY };
    const { collection } = collectionInUse(extension_settings.vectfox);
    if (!collection) return { problem: 'This chat has no collection in use.' };
    const record = readEntityLoreRecord(getCollectionMeta(collection.registryKey).entityLore);
    setCollectionMeta(collection.registryKey, { entityLore: withEntryForgotten(record, name) });
    return { problem: null };
}

/**
 * The open chat's characters for the Entity-Lore card (§3): each person's state, as a run reads it, so a row says what
 * the next run does, and the chat's book: its name, whether it is made yet, and whether this chat loads it. Saves nothing.
 * @param {object} [settings] - VectFox settings, the live ones by default
 * @returns {Promise<{problem: string}|{chatId: string, bookName: string, isBookMade: boolean, isBookInChat: boolean, states: object[]}>}
 */
export async function readEntityLoreCharacters(settings = extension_settings.vectfox) {
    const chat = await readChatEntities(settings);
    if (chat.problem) return { problem: chat.problem };
    const chatId = getCurrentChatId();
    const bookName = chat.record.bookName || npcBookName(chatId);
    return { chatId, bookName, isBookMade: Boolean(chat.record.bookName), isBookInChat: chatBookNames().includes(bookName), states: chat.states };
}

/**
 * The last run that wrote or tried an entry since the page loaded: its chat and its outcome, as the progress panel said
 * it (§3's status line). Null before one.
 * @returns {{chatId: string, text: string, isClean: boolean}|null}
 */
export function lastEntityLoreRun() {
    return lastRun;
}

/**
 * Hear each run end, whatever it wrote: the card reads the states again.
 * @param {() => void} listener
 */
export function onEntityLoreRunEnded(listener) {
    runEndedListeners.add(listener);
}

function tellRunEnded() {
    for (const listener of runEndedListeners) {
        try {
            listener();
        } catch (error) {
            log.warn(`${LOG} A listener to a run's end failed:`, error);
        }
    }
}

/**
 * One run, then one more when an EventBase run ended during it. Never throws: what fails is logged.
 * @param {object} settings - VectFox settings
 * @param {RunScope} scope - What it writes
 */
async function runEntityLore(settings, scope) {
    const run = { isStopped: false, chatId: getCurrentChatId() };
    activeRun = run;
    const stop = () => { run.isStopped = true; };
    eventSource.on(event_types.CHAT_CHANGED, stop);
    try {
        const outcome = await writeDueEntries(settings, run, scope);
        if (outcome) lastRun = { chatId: run.chatId, ...outcome };
    } catch (error) {
        log.error(`${LOG} The run failed:`, error);
    } finally {
        eventSource.removeListener(event_types.CHAT_CHANGED, stop);
        activeRun = null;
    }
    tellRunEnded();
    if (!isRunAgain) return;
    isRunAgain = false;
    if (!entityLoreProblem(settings)) await runEntityLore(settings, wholeRun(ENTRIES_PER_AUTOMATIC_RUN));
}

/**
 * The open chat's characters as Entity-Lore sees them: its collection in use and stored events, StoryArc's merges and
 * people, the record, its book's entries, what excludes a name here, and each person's state (§4.2). A record whose
 * book is gone starts over (D13), and each entry gone from its book reads as deleted (§6).
 * @param {object} settings - VectFox settings
 * @returns {Promise<{problem: string}|{registryKey: string, events: object[], merges: object, rows: object[], record: object,
 *   bookEntries: object[], exclusions: object, states: object[]}>}
 */
async function readChatEntities(settings) {
    const story = await readChatStoryEvents(settings);
    if (story.problem) return { problem: story.problem };
    const { registryKey, events } = story;
    const merges = readEntityMerges([registryKey]);
    const rows = listEntities(events, merges, 'people');
    let record = readEntityLoreRecord(getCollectionMeta(registryKey).entityLore);
    let bookEntries = [];
    if (record.bookName && !world_names.includes(record.bookName)) {
        record = withBookStartedOver(record);
    } else if (record.bookName) {
        bookEntries = Object.values((await loadWorldInfo(record.bookName))?.entries ?? {});
        record = withMissingEntriesDeleted(record, bookEntries.map(entry => entry.uid));
    }
    const exclusions = await chatExclusions(record.bookName);
    const states = statesOf(settings, { rows, record, exclusions, bookEntries });
    return { registryKey, events, merges, rows, record, bookEntries, exclusions, states };
}

function statesOf(settings, { rows, record, exclusions, bookEntries }) {
    return entityLoreStates(rows, {
        record,
        writeAt: writeAtEventsOf(settings[ENTITY_LORE_SETTING.writeAtEvents]),
        rewriteEvery: rewriteEveryEventsOf(settings[ENTITY_LORE_SETTING.rewriteEveryEvents]),
        chat: exclusions,
        bookEntries,
    });
}

/**
 * What excludes a name in the open chat (§4.2): its characters, the persona, the titles and keys of the entries of every
 * book it loads but Entity-Lore's own, and its characters' card descriptions. A book that cannot be read is logged and
 * excludes nothing.
 * @param {string} ownBookName - Entity-Lore's book, '' while it has none
 * @returns {Promise<object>} What exclusionOf reads
 */
async function chatExclusions(ownBookName) {
    const characters = chatCharacters();
    const loreNames = [];
    for (const bookName of chatBookNames().filter(name => name !== ownBookName)) {
        try {
            for (const entry of Object.values((await loadWorldInfo(bookName))?.entries ?? {})) loreNames.push(entry.comment, ...(entry.key ?? []));
        } catch (error) {
            log.warn(`${LOG} Lorebook "${bookName}" could not be read, so its names exclude no one this run:`, error);
        }
    }
    return {
        characterNames: characters.map(character => character.name),
        personaName: String(getContext().name1 ?? ''),
        loreNames: loreNames.filter(name => typeof name === 'string' && name.trim()),
        isInCardDescription: name => characters.some(character => holdsName(character.description, name)),
    };
}

/**
 * The run's steps on the progress panel: the name check, then each entry, then LoreBase's keys and vectors.
 * @param {object} settings - VectFox settings
 * @param {{isStopped: boolean, chatId: string}} run
 * @param {RunScope} scope
 * @returns {Promise<{text: string, isClean: boolean}|null>} What the panel said, null when no entry was due
 */
async function writeDueEntries(settings, run, scope) {
    const chat = await readChatEntities(settings);
    if (chat.problem) {
        log.verbose(`${LOG} Nothing to write: ${chat.problem}`);
        return null;
    }
    const job = {
        settings, run, chat, record: chat.record, rewrittenUids: [],
        outcome: { written: 0, rewritten: 0, failed: 0, bookProblem: null },
        ask: askTextOnLoreBase(resolveLoreBaseLlmConfig(settings), { timeoutMs: CALL_TIMEOUT_MS, contextLabel: CONTEXT_LABEL }),
        writeName: buildEntityNameWriter(chat.merges, chat.events),
        languageName: chineseScriptNameOf(readStoryLanguage(chatMessages(), settings)),
        saves: Promise.resolve(),
    };
    if (JSON.stringify(job.record) !== JSON.stringify(readEntityLoreRecord(getCollectionMeta(chat.registryKey).entityLore))) saveRecord(job);
    const planned = scope.pickFrom(chat.states);
    const due = scope.dueToCheck(chat.states);
    const outcome = planned.length ? await writeOnPanel(job, { planned, due, scope }) : null;
    await writeLoreBaseKeysAndVectors(job);
    return outcome;
}

/**
 * The run's name check and entries under the progress panel, with its Stop.
 * @returns {Promise<{text: string, isClean: boolean}>} The summary the panel ends on, and whether nothing failed
 */
async function writeOnPanel(job, { planned, due, scope }) {
    const { run, outcome } = job;
    let done = 0;
    const advance = () => {
        done += 1;
        progressTracker.updateProgress(done);
    };
    progressTracker.show(CONTEXT_LABEL, (due.length ? 1 : 0) + planned.length, 'Entries', { unitLabel: 'Entries' });
    progressTracker.setCancelHandler(() => { run.isStopped = true; });
    let picks = planned;
    if (due.length) {
        progressTracker.updateCurrentItem(`Checking ${counted(due.length, 'name', 'names')}`);
        if (await checkNames(job, due)) {
            picks = scope.pickFrom(statesOf(job.settings, { ...job.chat, record: job.record }));
        } else {
            picks = planned.filter(each => each.state === ENTITY_STATE.rewriteDue);
        }
        advance();
        for (let skipped = planned.length - picks.length; skipped > 0; skipped -= 1) advance();
    }
    const queue = [...picks];
    let position = 0;
    const writeNext = async () => {
        while (queue.length && !run.isStopped) {
            const pick = queue.shift();
            position += 1;
            progressTracker.updateCurrentItem(`Writing ${pick.name}, ${position} of ${picks.length}`);
            await writeOneEntry(job, pick);
            advance();
        }
    };
    await Promise.all(Array.from({ length: ENTRIES_AT_ONCE }, writeNext));
    const summary = job.outcome.bookProblem ? `${runOutcomeText(outcome)}. ${job.outcome.bookProblem}` : runOutcomeText(outcome);
    const isClean = !outcome.failed && !outcome.bookProblem;
    progressTracker.complete(isClean, summary);
    log.lifecycle(`${LOG} ${summary}${run.isStopped ? ' (stopped)' : ''}`);
    return { text: summary, isClean };
}

/**
 * The name check on every name due (§4.3): each answer read goes in the record, a same_as naming an entry already
 * written adds the name to that entry's keys, and a name with no answer read stays due. False when the check failed, so
 * no new entry is written this run.
 * @returns {Promise<boolean>}
 */
async function checkNames(job, due) {
    const candidates = due.map(row => ({ name: row.name, eventCount: row.eventCount, eventLine: eventLinesOf(job, [row.name])[0] ?? '' }));
    const check = { candidates, entryTitles: writtenEntryTitles(job.record) };
    try {
        const items = parseJsonArrayFromLlm(await job.ask(nameCheckMessages(check), NAME_CHECK_REQUEST), { label: CONTEXT_LABEL, identKeys: ['name'] });
        const { answers, unreadItemCount } = readNameCheck(items, check);
        if (unreadItemCount) log.warn(`${LOG} The name check: ${counted(unreadItemCount, 'answer', 'answers')} could not be read; those names stay due`);
        for (const answer of answers.filter(each => each.answer !== NAME_CHECK_ANSWER.named)) {
            job.record = withNameCheckAnswer(job.record, answer.name, { state: answer.answer, sameAs: answer.sameAs });
            if (answer.answer === NAME_CHECK_ANSWER.sameAs) await keyWrittenEntry(job, answer.sameAs, answer.name);
        }
        saveRecord(job);
        log.lifecycle(`${LOG} The name check: ${answers.map(each => `${each.name} ${each.answer}${each.sameAs ? ` ${each.sameAs}` : ''}`).join(', ')}`);
        return true;
    } catch (error) {
        failCall(job, 'The name check', error);
        return false;
    }
}

/** Add a name the check matched to an entry already written to that entry's keys, in its book. */
async function keyWrittenEntry(job, title, name) {
    const written = recordOfName(job.record, title);
    if (written?.state !== RECORD_STATE.written || !job.record.bookName) return;
    await inBookTurn(job, async () => {
        const entry = Object.values((await loadWorldInfo(job.record.bookName))?.entries ?? {}).find(each => String(each.uid) === written.uid);
        if (!entry) return;
        const keys = entryKeysOf({ name: title, otherNames: [name] }, entry.key ?? []);
        if (keys.length !== (entry.key ?? []).length) await saveLorebookEntry(job.record.bookName, written.uid, { comment: entry.comment, content: entry.content, keys });
    }).catch(error => log.warn(`${LOG} ${title}: "${name}" could not be added to its keys:`, error));
}

/** Write one entry, new or again: its text from LoreBase's model, then its save. What fails is logged and counted. */
async function writeOneEntry(job, pick) {
    const otherNames = [...pick.otherNames, ...namesMatchedTo(job.record, pick.name)];
    const isRewrite = pick.state === ENTITY_STATE.rewriteDue;
    let content;
    try {
        const standingEntry = isRewrite ? (await bookEntryOf(job, pick.uid))?.content ?? null : null;
        if (isRewrite && standingEntry === null) return;
        content = await entryText(job, pick, otherNames, standingEntry);
    } catch (error) {
        failCall(job, pick.name, error);
        return;
    }
    await inBookTurn(job, () => (isRewrite ? saveRewrite(job, pick, otherNames, content) : saveNewEntry(job, pick, otherNames, content)))
        .catch((error) => {
            job.outcome.bookProblem = `The lorebook could not be saved: ${String(error?.message ?? error).slice(0, 200)}`;
            log.error(`${LOG} ${pick.name}: the lorebook could not be saved, so the run stops:`, error);
            job.run.isStopped = true;
        });
}

/** A call that failed: a model the provider refuses raises the sticky popup and stops the run; any other is logged. */
function failCall(job, what, error) {
    job.outcome.failed += 1;
    progressTracker.addError(`${what}: ${String(error?.message ?? error).slice(0, 200)}`);
    if (isInvalidModelConfigError(error)) {
        notifyInvalidModel(error.message);
        job.run.isStopped = true;
        return;
    }
    log.warn(`${LOG} ${what}:`, error);
}

/** Run a step of the book's saves after the ones before it, as each saves a loaded copy of the whole book. */
function inBookTurn(job, step) {
    const turn = job.saves.then(step);
    // EXPECTED: the caller handles the step's failure on `turn`; the chain only waits for the step to end.
    job.saves = turn.catch(() => {});
    return turn;
}

/** The lines of every event naming any of `names`, each once, oldest first, as StoryArc reads them (§4.4). */
function eventLinesOf(job, names) {
    const found = new Set(names.flatMap(name => eventsNamingEntity(job.chat.events, job.chat.merges, name)));
    return withKeptEntityNames(inTimelineOrder([...found]), job.writeName).map(formatStoryLine);
}

/**
 * An entry's text from LoreBase's model (§4.4, §5.2): from the events of the character and the names matched to it, or,
 * above one slice, from the notes a call writes on each slice; a rewrite reads the entry as it stands too.
 * @returns {Promise<string>}
 * @throws {Error} When a call fails or its answer is no entry or no notes
 */
async function entryText(job, pick, otherNames, standingEntry) {
    const lines = eventLinesOf(job, [pick.name, ...namesMatchedTo(job.record, pick.name)]);
    const slices = sliceEventLines(lines, estimatedTokens);
    const entry = { name: pick.name, otherNames, standingEntry, languageName: job.languageName };
    let messages = entryMessages({ ...entry, storyText: lines.join('\n') });
    if (slices.length > 1) {
        const notes = [];
        for (const [index, eventLines] of slices.entries()) {
            const slice = { name: pick.name, eventLines, sliceNumber: index + 1, sliceCount: slices.length, languageName: job.languageName };
            const read = readNotesAnswer(await job.ask(notesMessages(slice), ENTRY_REQUEST));
            if (read.problem) throw new Error(`the notes on part ${index + 1} of ${slices.length}: ${read.problem}`);
            notes.push(read.notes);
        }
        messages = entryMessages({ ...entry, storyText: notes.join('\n\n'), isFromNotes: true });
    }
    const read = readEntryAnswer(await job.ask(messages, ENTRY_REQUEST));
    if (read.problem) throw new Error(read.problem);
    return read.entry;
}

async function bookEntryOf(job, uid) {
    return Object.values((await loadWorldInfo(job.record.bookName))?.entries ?? {}).find(entry => String(entry.uid) === String(uid)) ?? null;
}

/**
 * Save a new entry (§4.6): the chat's book made and added to the chat when it has none, or added again when the user
 * unlinked it, which only the run's own chat may be; the entry; it joins the selection in use there; the record.
 * While another chat is open a book that must be made or added waits, and the entry stays due.
 */
async function saveNewEntry(job, pick, otherNames, content) {
    const bookName = await chatBook(job);
    if (!bookName) return;
    const uid = await createLorebookEntry(bookName, { comment: pick.name, keys: entryKeysOf({ name: pick.name, otherNames }), content });
    const selection = selectionInUse(bookName, { chatId: job.run.chatId }) ?? lockedToChat(bookName, job.run.chatId);
    setLoreBookSelection(bookName, selection.id, [...selection.selectedUids, uid]);
    job.record = withWrittenEntry(job.record, pick.name, { uid, writtenAtEvents: pick.eventCount, content });
    saveRecord(job);
    job.outcome.written += 1;
}

/** The book's first selection, locked to the run's chat: a book whose LoreBase record the user removed has none in use there. */
function lockedToChat(bookName, chatId) {
    const selection = ensureLoreSelection(bookName);
    setLoreSelectionLock(bookName, selection.id, { chatId }, true);
    return selection;
}

/** The book of the run's chat, made and added to the chat as needed; null while another chat is open and it must be. */
async function chatBook(job) {
    const isRunChatOpen = getCurrentChatId() === job.run.chatId;
    let { bookName } = job.record;
    if (!bookName) {
        if (!isRunChatOpen) return null;
        bookName = await createLorebook(npcBookName(job.run.chatId));
        job.record = withBookName(job.record, bookName);
        saveRecord(job);
        log.lifecycle(`${LOG} Made the lorebook "${bookName}" for this chat`);
    }
    if (isRunChatOpen && !chatBookNames().includes(bookName)) await addLoreBookToChat(bookName, ADD_TO_CHAT);
    return bookName;
}

/**
 * Save an entry written again (§5.3) through LoreBase's entry save, which writes its vectors, its keys its names and
 * those it had. An entry the user deleted meanwhile is left gone, and one they edited is left as it is, unless they
 * asked to rewrite it anyway (`isEditAccepted`); one LoreBase cannot save while it writes stays due.
 */
async function saveRewrite(job, pick, otherNames, content) {
    const entry = await bookEntryOf(job, pick.uid);
    const written = recordOfName(job.record, pick.name);
    if (!entry || (!pick.isEditAccepted && entryContentHash(entry.content) !== written?.contentHash)) return;
    if (isLoreBaseWriting()) {
        log.lifecycle(`${LOG} ${pick.name}: LoreBase is writing, so its rewrite waits for the next run`);
        return;
    }
    const keys = entryKeysOf({ name: pick.name, otherNames }, entry.key ?? []);
    const { failure } = await saveEntryWithVectors(job.record.bookName, pick.uid, { comment: entry.comment, content, keys }, job.settings);
    if (failure) log.warn(`${LOG} ${pick.name}: its vectors could not be written; LoreBase writes them with the book's next keys and vectors:`, failure.detail);
    job.record = withWrittenEntry(job.record, pick.name, { uid: pick.uid, writtenAtEvents: pick.eventCount, content });
    saveRecord(job);
    job.rewrittenUids.push(String(pick.uid));
    job.outcome.rewritten += 1;
}

function saveRecord(job) {
    setCollectionMeta(job.chat.registryKey, { entityLore: job.record });
}

/**
 * LoreBase's keys and vectors for the book's entries that lack them, on LoreBase's own panel, then its keys again for
 * each entry rewritten (§4.6, §5.3). While LoreBase writes others, they wait for the next run, as they do once another
 * chat is open: a key run locks the books it keys to the chat open then.
 */
async function writeLoreBaseKeysAndVectors(job) {
    const { bookName } = job.record;
    if (!bookName || !world_names.includes(bookName)) return;
    const waitReason = isLoreBaseWriting() ? 'LoreBase is writing' : getCurrentChatId() !== job.run.chatId ? 'another chat is open' : '';
    if (waitReason) {
        log.lifecycle(`${LOG} ${waitReason}, so the keys and vectors of "${bookName}" wait for the next run`);
        return;
    }
    try {
        await writeMissing(job.settings, BOTH_KINDS, { bookNames: [bookName] });
        if (!job.rewrittenUids.length) return;
        const entries = Object.values((await loadWorldInfo(bookName))?.entries ?? {}).filter(entry => job.rewrittenUids.includes(String(entry.uid)));
        if (entries.length) await regenerateKeysOfEntries(bookName, entries, job.settings);
    } catch (error) {
        log.warn(`${LOG} LoreBase could not write the keys and vectors of "${bookName}"; the next run tries again:`, error);
    }
}
