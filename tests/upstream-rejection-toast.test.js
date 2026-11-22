/**
 * A provider's rejection asks the user to act, and the run carries on past it, so it
 * is a warning: red means a run stopped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn() } }));

const { notifyUpstreamRejection, describeUpstreamRejectionCauses } = await import('../src/shared/model-config-notifier.js');

describe('notifyUpstreamRejection', () => {
    beforeEach(() => {
        globalThis.toastr = { error: vi.fn(), warning: vi.fn() };
    });

    it('raises a sticky warning, not a red toast', () => {
        notifyUpstreamRejection('EventBase', 'first/model', 'Bad Request');

        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        const [message, title, options] = globalThis.toastr.warning.mock.calls[0];
        expect(message).toContain('rejected the EventBase request for model "first/model" (Bad Request)');
        expect(title).toContain('EventBase request rejected');
        expect(options).toEqual({ timeOut: 0, extendedTimeOut: 0 });
    });

    it('warns once for the same model and status', () => {
        notifyUpstreamRejection('EventBase', 'second/model', 'Bad Request');
        notifyUpstreamRejection('EventBase', 'second/model', 'Bad Request');

        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
    });

    it('names the account when it is out of quota', () => {
        notifyUpstreamRejection('EventBase', 'third/model', 'Too Many Requests', true);

        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('out of quota');
    });

    // An EventBase run names the same causes at its end, for a window still rejected after its re-sends.
    it('names the causes a run\'s notice names', () => {
        notifyUpstreamRejection('EventBase', 'fourth/model', 'Bad Request');

        const [message] = globalThis.toastr.warning.mock.calls[0];
        expect(describeUpstreamRejectionCauses()).toContain('Common causes');
        expect(message).toContain(describeUpstreamRejectionCauses());
    });
});
