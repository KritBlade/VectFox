/**
 * ============================================================================
 * CONNECTION ROWS
 * ============================================================================
 * The Provider dropdowns of the four LLM consumers and of embedding (connection plan
 * §1, §3): what each saves, the SillyTavern profile option with the Profile dropdown
 * and readout it shows, the rows a profile supplies hidden while one is chosen, the
 * profile Agent Mode and Auto-Reformat take from the EventBase model, and each card's
 * Test connection. The Profile dropdowns repaint when a profile is made, saved or
 * deleted in SillyTavern.
 * ============================================================================
 */

import { isConnectionManagerAvailable, listConnectionProfileChoices, onConnectionProfilesChanged } from '../../sillytavern/connection-profiles.js';
import { log } from '../../sillytavern/log.js';
import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { CONNECTION_PROFILE_PROVIDER } from '../../shared/constants.js';
import { connectionProfileRowIds } from '../../shared/connection-profile-rows-markup.js';
import { resultList, selectOption } from '../../shared/gui-dna/gui-dna-core.js';
import { setShown } from '../../shared/gui-dna/gene-behaviours.js';
import { testAutoReformatConnection } from '../chunkbase/index.js';
import { embeddingProfileKind, resolveEmbeddingProfile } from '../embedding/index.js';
import { testAgentModeConnection, testEventBaseConnection, testStoryArcConnection } from '../eventbase/index.js';
import { describeChatConnectionProfile, resolveInheritedConnection } from '../llm-provider/index.js';
import { getBackend } from '../vector-backend/index.js';
import { chatProfileReadoutLines, embeddingProfileReadoutLines, profileSelectOptions } from './connection-rows-core.js';

const EMBEDDING_PREFIX = 'VectFox_embedding';

/** What embedding's Test connection embeds: a fixed line, so a test never carries chat text. */
const EMBEDDING_TEST_TEXT = 'This is a connection test from VectFox.';

const byId = id => document.getElementById(id);
const fieldOf = inputId => byId(inputId)?.closest('.vfx-field') ?? null;
const textOf = value => String(value ?? '').trim();

/**
 * The four LLM consumers. `blankProvider` is what an unset provider means; '' is Same as EventBase model for the two
 * that `inheritsEventBase`. `manualRows` lists each row a choice shows, given the consumer's view.
 */
const CHAT_CONSUMERS = [
    {
        prefix: 'VectFox_summarize', providerSelectId: 'VectFox_summarize_provider', providerKey: 'chat_provider',
        profileKey: 'chat_connection_profile_id', feature: 'EventBase', page: 'Core', blankProvider: 'openrouter',
        inheritsEventBase: false, test: testEventBaseConnection,
        manualRows: view => [
            [byId('VectFox_summarize_settings'), !view.isOnProfile],
            [byId('VectFox_summarize_openrouter_row'), view.provider === 'openrouter'],
            [byId('VectFox_summarize_vllm_url_row'), view.provider === 'vllm'],
        ],
    },
    {
        prefix: 'VectFox_agentic', providerSelectId: 'VectFox_agentic_provider', providerKey: 'agent_provider',
        profileKey: 'agent_connection_profile_id', feature: 'Agent Mode', page: 'AgentMode', blankProvider: '',
        inheritsEventBase: true, test: testAgentModeConnection,
        manualRows: view => [
            [byId('VectFox_agentic_openrouter_row'), view.ownProvider === 'openrouter'],
            [byId('VectFox_agentic_vllm_row'), view.ownProvider === 'vllm'],
            [fieldOf('VectFox_agentic_model'), !view.isOnProfile],
            [byId('VectFox_agentic_provider_hint'), !view.isOnProfile],
        ],
    },
    {
        prefix: 'VectFox_reformat', providerSelectId: 'VectFox_reformat_provider', providerKey: 'reformat_provider',
        profileKey: 'reformat_connection_profile_id', feature: 'Auto-Reformat', page: 'ChunkBase', blankProvider: '',
        inheritsEventBase: true, test: testAutoReformatConnection,
        manualRows: view => [
            [byId('VectFox_reformat_vllm_row'), view.ownProvider === 'vllm'],
            [fieldOf('VectFox_reformat_model'), !view.isOnProfile],
            [byId('VectFox_reformat_provider_hint'), !view.isOnProfile],
        ],
    },
    {
        prefix: 'VectFox_story_arc_link', providerSelectId: 'VectFox_story_arc_link_provider', providerKey: 'story_arc_link_provider',
        profileKey: 'story_arc_link_connection_profile_id', feature: 'StoryArc', page: 'StoryArc', blankProvider: 'openrouter',
        inheritsEventBase: false, test: testStoryArcConnection,
        manualRows: view => [[fieldOf('VectFox_story_arc_link_model'), !view.isOnProfile]],
    },
];

function save(settings) {
    Object.assign(extension_settings.vectfox, settings);
    saveSettingsDebounced();
}

/** Every profile, each marked as `offer` decides for one dropdown; none when the Connection Manager is off. */
function profilesFor(isManagerAvailable, offer) {
    if (!isManagerAvailable) return [];
    return listConnectionProfileChoices().map(choice => ({ ...choice, isOffered: offer(choice) }));
}

function paintProfileSelect(select, { profiles, selectedId, isManagerAvailable }) {
    if (!select) return;
    const options = profileSelectOptions({ profiles, selectedId, isManagerAvailable });
    select.innerHTML = options.map(({ value, text, name, isSelected }) => selectOption({ value, text, name, isSelected })).join('');
    options.forEach(({ isDisabled }, index) => { select.options[index].disabled = isDisabled; });
    select.selectedIndex = Math.max(0, options.findIndex(option => option.isSelected));
}

function paintReadout(element, lines) {
    if (element) element.innerHTML = lines.length ? resultList({ lines }) : '';
}

/**
 * How a chat consumer runs: the provider its own dropdown holds and the one it runs on, Same as EventBase model
 * resolved, and whether that is its own profile or the EventBase model's.
 */
function chatConsumerView(consumer, settings) {
    const ownProvider = (textOf(settings[consumer.providerKey]) || consumer.blankProvider).toLowerCase();
    const provider = consumer.inheritsEventBase ? resolveInheritedConnection({ provider: ownProvider }, settings).provider : ownProvider;
    const isOwnProfile = ownProvider === CONNECTION_PROFILE_PROVIDER;
    const isOnProfile = provider === CONNECTION_PROFILE_PROVIDER;
    return { ownProvider, provider, isOwnProfile, isOnProfile, isInheritedProfile: isOnProfile && !isOwnProfile };
}

function refreshChatConsumer(consumer, settings, isManagerAvailable) {
    const ids = connectionProfileRowIds(consumer.prefix);
    const view = chatConsumerView(consumer, settings);
    for (const [row, isShown] of consumer.manualRows(view)) setShown(row, isShown);
    setShown(byId(ids.rows), view.isOwnProfile);
    if (view.isOwnProfile) {
        const selectedId = textOf(settings[consumer.profileKey]);
        const profiles = profilesFor(isManagerAvailable, choice => choice.isSupported);
        paintProfileSelect(byId(ids.select), { profiles, selectedId, isManagerAvailable });
        const description = describeChatConnectionProfile(selectedId, { feature: consumer.feature, page: consumer.page });
        paintReadout(byId(ids.readout), chatProfileReadoutLines(description));
    }
    if (consumer.inheritsEventBase) {
        setShown(byId(ids.inheritedReadout), view.isInheritedProfile);
        if (view.isInheritedProfile) {
            const description = describeChatConnectionProfile(textOf(settings.chat_connection_profile_id), { feature: consumer.feature, page: 'Core' });
            paintReadout(byId(ids.inheritedReadout), chatProfileReadoutLines(description, { isInherited: true }));
        }
    }
}

/**
 * Which option embedding's Provider dropdown shows: SillyTavern profile while a profile carries it (a stored profile
 * ID, or a provider only a profile carries), else the stored provider. That option is never stored itself.
 */
function embeddingChoice(settings) {
    const kind = embeddingProfileKind(settings.embedding_provider);
    const isOnProfile = Boolean(kind) && (Boolean(textOf(settings.embedding_connection_profile_id)) || !kind.hasManualFields);
    return isOnProfile ? CONNECTION_PROFILE_PROVIDER : textOf(settings.embedding_provider);
}

/**
 * Show the rows of the option embedding's dropdown shows: a manual provider's own rows, or the Profile dropdown and
 * its readout. On an Ollama profile, Ollama's Keep model in memory still shows, since it still applies.
 */
function refreshEmbedding(choice, settings, isManagerAvailable) {
    const ids = connectionProfileRowIds(EMBEDDING_PREFIX);
    const isProfileChoice = choice === CONNECTION_PROFILE_PROVIDER;
    const isStoredOnProfile = embeddingChoice(settings) === CONNECTION_PROFILE_PROVIDER;
    const shownGroup = isProfileChoice ? (isStoredOnProfile && settings.embedding_provider === 'ollama' ? 'ollama' : '') : choice;
    for (const group of document.querySelectorAll('#VectFox_provider_settings > [data-provider]')) {
        setShown(group, group.dataset.provider === shownGroup);
    }
    setShown(byId('VectFox_ollama_manual_rows'), !isProfileChoice);
    setShown(byId(ids.rows), isProfileChoice);
    if (!isProfileChoice) return;
    const profiles = profilesFor(isManagerAvailable, choice => Boolean(embeddingProfileKind(choice.embeddingProvider)));
    const selectedId = isStoredOnProfile ? textOf(settings.embedding_connection_profile_id) : '';
    paintProfileSelect(byId(ids.select), { profiles, selectedId, isManagerAvailable });
    paintReadout(byId(ids.readout), embeddingProfileReadoutLines({
        resolved: isStoredOnProfile ? resolveEmbeddingProfile(settings) : null,
        kind: isStoredOnProfile ? embeddingProfileKind(settings.embedding_provider) : null,
        hasEmbeddingProfiles: !isManagerAvailable || profiles.some(profile => profile.isOffered),
    }));
}

/** Embedding's Test connection: the fixed line embedded as a query is, on the active backend. */
async function testEmbeddingConnection(settings) {
    const backend = await getBackend(settings);
    const vector = await backend.embedQuery(EMBEDDING_TEST_TEXT, settings);
    if (!Array.isArray(vector) || !vector.length) {
        throw new Error('Embedding: the test embeds through the Similharity plugin, which this backend did not find. Install Similharity, then reload.');
    }
    return { content: `${vector.length} dimensions`, cutReason: null };
}

/** Run a card's Test connection, and say how it went. */
async function runConnectionTest(button, feature, test) {
    button.disabled = true;
    toastr.info(`Sending one short test message on ${feature}'s connection…`, 'VectFox');
    try {
        const { content, cutReason } = await test();
        const reply = textOf(content);
        const preview = reply.length > 160 ? `${reply.slice(0, 160)}…` : reply;
        toastr.success(`${preview || '(an empty reply)'}${cutReason ? ` (cut short by the provider: ${cutReason})` : ''}`, `${feature}: the connection works`, { timeOut: 9000 });
    } catch (error) {
        log.warn(`${feature}: the connection test failed:`, error);
        toastr.error(error?.message || String(error), `${feature}: the connection test failed`, { timeOut: 15000 });
    } finally {
        button.disabled = false;
    }
}

/**
 * Wire the five Provider dropdowns, their profile rows and their Test connection buttons.
 *
 * @param {object} settings - The settings panel's settings object
 * @param {{onEmbeddingProviderChange: () => void}} hooks - Runs after embedding's provider or profile is saved
 */
export function wireConnectionRows(settings, { onEmbeddingProviderChange }) {
    const refreshChatConsumers = () => {
        const isManagerAvailable = isConnectionManagerAvailable();
        for (const consumer of CHAT_CONSUMERS) refreshChatConsumer(consumer, settings, isManagerAvailable);
    };
    const embeddingSelect = byId('VectFox_source');
    const refreshEmbeddingRows = () => refreshEmbedding(embeddingSelect?.value ?? '', settings, isConnectionManagerAvailable());

    for (const consumer of CHAT_CONSUMERS) {
        const ids = connectionProfileRowIds(consumer.prefix);
        $(`#${consumer.providerSelectId}`)
            .val(textOf(settings[consumer.providerKey]) || consumer.blankProvider)
            .on('change', function () {
                settings[consumer.providerKey] = String($(this).val());
                save(settings);
                refreshChatConsumers();
            });
        $(`#${ids.select}`).on('change', function () {
            settings[consumer.profileKey] = String($(this).val());
            save(settings);
            refreshChatConsumers();
        });
        $(`#${ids.testButton}`).on('click', function () {
            runConnectionTest(this, consumer.feature, () => consumer.test(settings));
        });
    }

    const embeddingIds = connectionProfileRowIds(EMBEDDING_PREFIX);
    $(embeddingSelect)
        .val(embeddingChoice(settings))
        .on('change', function () {
            const choice = String($(this).val());
            if (choice !== CONNECTION_PROFILE_PROVIDER) {
                settings.embedding_provider = choice;
                settings.embedding_connection_profile_id = '';
                save(settings);
                onEmbeddingProviderChange();
            }
            refreshEmbeddingRows();
        });
    $(`#${embeddingIds.select}`).on('change', function () {
        const choice = listConnectionProfileChoices().find(profile => profile.id === String($(this).val()));
        if (!choice || !embeddingProfileKind(choice.embeddingProvider)) return;
        settings.embedding_connection_profile_id = choice.id;
        settings.embedding_provider = choice.embeddingProvider;
        save(settings);
        onEmbeddingProviderChange();
        refreshEmbeddingRows();
    });
    $(`#${embeddingIds.testButton}`).on('click', function () {
        runConnectionTest(this, 'Embedding', () => testEmbeddingConnection(settings));
    });

    onConnectionProfilesChanged(() => {
        refreshChatConsumers();
        refreshEmbeddingRows();
    });
    refreshChatConsumers();
    refreshEmbeddingRows();
}
