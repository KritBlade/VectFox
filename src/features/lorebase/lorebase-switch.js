/**
 * LoreBase's switch, on the WorldInfo page (plan §5.9 of InternalProject/Vectfox/plans/
 * lorebook-semantic-overhaul-passage-index.md). Off by default; while off, LoreBase picks nothing and leaves every
 * World Info scan to SillyTavern, so every entry fires by its keys, and the selections, pins and locks are kept.
 * LoreBase acts only while VectFox is on, its switch is on, and SillyTavern's Vector Storage has its World Info search
 * off: that search force-activates lorebook entries by similarity, a selected entry whole whatever Luna picks, and
 * LoreBase cannot take those back (lorebase-vector-storage.js asks the user which of the two to keep).
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
 * Whether LoreBase acts now: VectFox and LoreBase on, and Vector Storage's World Info search off.
 * @param {object} [settings] - VectFox settings, the live ones by default
 * @returns {boolean}
 */
export function isLoreBaseActive(settings = extension_settings.vectfox) {
    return isVectFoxEnabled(settings) && isLoreBaseSwitchedOn(settings) && !isVectorStorageWorldInfoOn();
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
