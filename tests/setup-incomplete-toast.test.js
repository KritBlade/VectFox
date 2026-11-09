/**
 * A feature switched on that cannot run as set up asks the user to act, while each turn
 * carries on without it, so it is a sticky warning: red means a run stopped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notifySetupIncomplete, resetSetupIncompleteNotifications } = await import('../src/shared/model-config-notifier.js');

describe('notifySetupIncomplete', () => {
    beforeEach(() => {
        globalThis.toastr = { error: vi.fn(), warning: vi.fn() };
        resetSetupIncompleteNotifications();
    });

    it('raises a sticky warning, not a red toast', () => {
        notifySetupIncomplete('Agent Mode', 'Agent Mode is on, but it has no model.');

        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(
            'Agent Mode is on, but it has no model.',
            'VectFox — Agent Mode not running',
            { timeOut: 0, extendedTimeOut: 0 },
        );
    });

    it('warns once for the same message, and again for another', () => {
        notifySetupIncomplete('Agent Mode', 'first problem');
        notifySetupIncomplete('Agent Mode', 'first problem');
        notifySetupIncomplete('Agent Mode', 'second problem');

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });
});
