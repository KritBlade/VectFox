/**
 * ============================================================================
 * GENE BEHAVIOURS
 * ============================================================================
 * The behaviours every VectFox surface on GUI-DNA shares (mvu-helper/devdoc/gui-dna.md
 * §7), bound once on the surface's root by its shell: the settings panel
 * (settings-panel/panel-shell.js) and the Database Browser. Delegated, so a field
 * or card painted later behaves the same way. Neither state is saved.
 * ============================================================================
 */

/**
 * Bind them on a surface's root: the (?) beside a label opens its field's longer explanation in place, a tap and never
 * a hover, and a card's or record's chevron collapses it.
 *
 * @param {HTMLElement|null} root
 */
export function bindGeneBehaviours(root) {
    const $root = $(root);
    $root.on('click', '.vfx-help-toggle', function () {
        const $field = $(this).closest('.vfx-field');
        const isOpen = !$field.hasClass('is-help-open');
        $field.toggleClass('is-help-open', isOpen);
        $(this).attr('aria-expanded', String(isOpen));
    });
    $root.on('click', '.vfx-collapse', function () {
        const $box = $(this).closest('.vfx-card, .vfx-record');
        const isCollapsed = !$box.hasClass('is-collapsed');
        $box.toggleClass('is-collapsed', isCollapsed);
        $(this).attr('aria-expanded', String(!isCollapsed));
    });
}
