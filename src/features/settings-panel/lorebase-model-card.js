/**
 * The WorldInfo page's LoreBase model card, the two lines it draws from settings of every page (§7.2 of
 * InternalProject/Vectfox/plans/executed/lorebook-multi-vector.md): the setup notice, naming the first thing LoreBase lacks
 * (loreBaseSetupProblem: Qdrant, VectFox's embedding model, LoreBase's model, then Jev's profile on Fast and Cheap
 * [Jev]), hidden while nothing is missing; and the Vectors line, naming VectFox's embedding model, whose button shows
 * the Core page that sets it. Both are drawn as the page opens, and again as a control on the card changes, as
 * LoreBase's switch is saved, which the notice's last sentence follows, and as SillyTavern's connection profiles
 * change. The card's own controls are wired by settings-panel.js and connection-rows.js.
 */
import { onConnectionProfilesChanged } from '../../sillytavern/connection-profiles.js';
import { embeddingModelName } from '../embedding/index.js';
import { loreBaseSetupProblem, onLoreBaseSwitchChange } from '../lorebase/index.js';
import { showPanelTab } from './panel-shell.js';
import { loreBaseSetupNoticeMarkup, loreBaseVectorsLineText } from './worldinfo-page-markup.js';

const CARD_ID = 'VectFox_lorebase_model_card';
const SETUP_NOTICE_ID = 'VectFox_lorebase_setup_notice';
const VECTORS_MODEL_ID = 'VectFox_lorebase_vectors_model';
const VECTORS_LINK_ID = 'VectFox_lorebase_vectors_link';
// The panel page that sets VectFox's embedding model (panel-shell-markup.js).
const EMBEDDING_PAGE = 'core';

// The settings the card was bound with: SillyTavern's own store of VectFox's settings, which every page writes.
let cardSettings = null;

/** Draw the setup notice and the Vectors line from the settings as they are now. */
export function refreshLoreBaseModelCard() {
    if (!cardSettings) return;
    const setupNotice = document.getElementById(SETUP_NOTICE_ID);
    if (setupNotice) {
        const problem = loreBaseSetupProblem(cardSettings);
        setupNotice.innerHTML = loreBaseSetupNoticeMarkup(problem);
        setupNotice.hidden = !problem;
    }
    const vectorsModel = document.getElementById(VECTORS_MODEL_ID);
    if (vectorsModel) vectorsModel.textContent = loreBaseVectorsLineText(embeddingModelName(cardSettings));
}

/**
 * Wire the Vectors line's button to the Core page, and draw the card's lines again after any control on it saves its
 * value, as a control's own listener runs before the card hears the event bubble up, as LoreBase's switch is saved,
 * and as SillyTavern's profiles change. Called once, as the panel is mounted.
 * @param {object} settings - VectFox settings
 */
export function bindLoreBaseModelCard(settings) {
    cardSettings = settings;
    document.getElementById(VECTORS_LINK_ID)?.addEventListener('click', () => showPanelTab(EMBEDDING_PAGE));
    const card = document.getElementById(CARD_ID);
    card?.addEventListener('change', refreshLoreBaseModelCard);
    card?.addEventListener('input', refreshLoreBaseModelCard);
    onConnectionProfilesChanged(refreshLoreBaseModelCard);
    onLoreBaseSwitchChange(refreshLoreBaseModelCard);
    refreshLoreBaseModelCard();
}
