/**
 * ============================================================================
 * GENE BEHAVIOURS
 * ============================================================================
 * The behaviours every VectFox surface on GUI-DNA shares (mvu-helper/devdoc/gui-dna.md
 * §7), for its shell: the settings panel (settings-panel/panel-shell.js) and the
 * Database Browser. The (?) and chevron toggles are bound once on the surface's
 * root, delegated, so a field or card painted later behaves the same way, and
 * neither state is saved. A page the nav switches to is shown from its top.
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

/**
 * Show a page the nav just switched to from its top. Every page of a surface scrolls in the same box (a top bar's main
 * pane, or a rail's dialog), so without this the new page opens as far down as the last one was scrolled. Every box
 * from the page up to its dialog goes back to the top. A page outside a dialog is left alone.
 *
 * @param {HTMLElement|null} page
 */
export function scrollPageToTop(page) {
    const dialog = page?.closest('dialog');
    if (!dialog) return;
    for (let box = page.parentElement; box && dialog.contains(box); box = box.parentElement) {
        box.scrollTop = 0;
    }
}
