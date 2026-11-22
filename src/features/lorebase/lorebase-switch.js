/**
 * LoreBase's switch, on the WorldInfo page (plan §5.9 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md). Off by default; while off, LoreBase picks nothing and leaves every
 * World Info scan to SillyTavern, so every entry fires by its keys, and the selections, pins and locks are kept.
 * LoreBase acts only while VectFox is on, its switch is on, the vector backend is Qdrant (D15), and SillyTavern's
 * Vector Storage has its World Info search off: that search force-activates lorebook entries by similarity, a selected
 * entry whole whatever LoreBase picks, and LoreBase cannot take those back (lorebase-vector-storage.js asks the user
 * which of the two to keep).
 */
import { isVectFoxEnabled } from '../../shared/feature-gate.js';
import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';
import { isVectorStorageWorldInfoOn } from '../../sillytavern/vector-storage.js';

const SWITCH_KEY = 'lorebase_enabled';
const switchListeners = new Set();

/**
 * Whether the user turned LoreBase on.
 * @param {object} [settings] - VectFox settings, the live ones by default
 * @returns {boolean}
 */
export function isLoreBaseSwitchedOn(settings = extension_settings.vectfox) {
    return settings?.[SWITCH_KEY] === true;
}

/**
 * Whether LoreBase can run on the chosen vector backend: only Qdrant, which keeps its keys and vectors (D15).
 * @param {object} [settings] - VectFox settings, the live ones by default
 * @returns {boolean}
 */
export function isLoreBaseBackend(settings = extension_settings.vectfox) {
    return settings?.vector_backend === 'qdrant';
}

/**
 * Why LoreBase does not act now, or null when it does: it acts with VectFox and LoreBase on, on Qdrant, and Vector
 * Storage's World Info search off.
 * @param {object} [settings] - VectFox settings, the live ones by default
 * @returns {string|null}
 */
export function loreBaseInactiveReason(settings = extension_settings.vectfox) {
    if (!isVectFoxEnabled(settings)) return 'VectFox is turned off.';
    if (!isLoreBaseSwitchedOn(settings)) return 'Use LoreBase is off.';
    if (!isLoreBaseBackend(settings)) return 'LoreBase runs on the Qdrant backend only.';
    if (isVectorStorageWorldInfoOn()) return "SillyTavern's Vector Storage has its World Info search on, which LoreBase leaves alone.";
    return null;
}

/**
 * Whether LoreBase acts now: VectFox and LoreBase on, on Qdrant, and Vector Storage's World Info search off.
 * @param {object} [settings] - VectFox settings, the live ones by default
 * @returns {boolean}
 */
export function isLoreBaseActive(settings = extension_settings.vectfox) {
    return loreBaseInactiveReason(settings) === null;
}

/**
 * Save LoreBase's switch, and tell whoever shows it.
 * @param {boolean} isOn
 */
export function saveLoreBaseSwitch(isOn) {
    extension_settings.vectfox[SWITCH_KEY] = isOn;
    saveSettingsDebounced();
    for (const listener of switchListeners) listener(isOn);
}

/** Turn LoreBase off: every entry fires by its keys again, and the selections, pins and locks are kept. */
export function turnLoreBaseOff() {
    saveLoreBaseSwitch(false);
}

/**
 * Call `listener` each time LoreBase's switch is saved, as when a reply's question turns LoreBase off.
 * @param {(isOn: boolean) => void} listener
 */
export function onLoreBaseSwitchChange(listener) {
    switchListeners.add(listener);
}
