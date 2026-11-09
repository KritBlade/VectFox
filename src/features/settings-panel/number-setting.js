/**
 * ============================================================================
 * NUMBER SETTING
 * ============================================================================
 * Wires a number box on a settings page to its own setting. A slider beside the
 * box follows it through the shell (panel-shell.js), so dragging saves the same way.
 * ============================================================================
 */

import { extension_settings, saveSettingsDebounced } from '../../sillytavern/settings.js';

/**
 * Wire a number box to its own setting. It shows `initial`, saves each typed value held to the box's min and max (whole
 * when `isInteger`), saves nothing while the box is empty or half-typed, and shows the saved value again once the user
 * leaves it.
 *
 * @param {object} settings - extension_settings.vectfox
 * @param {{id: string, key: string, initial: number, isInteger?: boolean}} box
 */
export function bindNumberSetting(settings, { id, key, initial, isInteger = false }) {
    $(`#${id}`)
        .val(initial)
        .on('input', function () {
            const typed = isInteger ? Number.parseInt(this.value, 10) : Number.parseFloat(this.value);
            if (Number.isNaN(typed)) return;
            const min = this.min === '' ? -Infinity : Number(this.min);
            const max = this.max === '' ? Infinity : Number(this.max);
            settings[key] = Math.min(max, Math.max(min, typed));
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
        })
        .on('change', function () {
            $(this).val(settings[key] ?? initial);
        });
}
