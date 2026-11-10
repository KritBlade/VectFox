/**
 * @vitest-environment jsdom
 *
 * The Action page's backend health pill (src/features/diagnostics/backend-health.js): hidden until a probe answers,
 * then a word in its status colour, never a bare dot: healthy, errors once a call failed, down when the probe failed.
 */
/* global document -- this file runs under the jsdom environment */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({
    probeBackendHealth: vi.fn(),
    backends: [],
}));

vi.mock('../src/features/vector-backend/index.js', () => ({
    probeBackendHealth: host.probeBackendHealth,
    getBackendMetrics: () => ({ backends: host.backends, activeBackends: [] }),
}));
vi.mock('../src/sillytavern/settings.js', () => ({ extension_settings: { vectfox: { vector_backend: 'qdrant' } } }));

const { getHealthPillHtml, refreshHealthPill } = await import('../src/features/diagnostics/backend-health.js');

const pill = () => document.getElementById('VectFox_health_pill');

beforeEach(() => {
    host.probeBackendHealth.mockReset();
    host.backends = [];
    document.body.innerHTML = getHealthPillHtml();
});

describe('backend health pill', () => {
    it('stays hidden until a probe answers', () => {
        expect(pill().style.display).toBe('none');
        expect(pill().textContent).toBe('');
    });

    it.each([
        [{ healthy: true, errors: 0 }, 'Backend healthy', 'is-success'],
        [{ healthy: true, errors: 3 }, 'Backend errors', 'is-warning'],
        [{ healthy: false, errors: 0 }, 'Backend down', 'is-danger'],
    ])('after a probe of %o, reads "%s"', async (metrics, word, statusClass) => {
        host.backends = [{ name: 'qdrant', ...metrics }];
        await refreshHealthPill();
        expect(host.probeBackendHealth).toHaveBeenCalledWith('qdrant', expect.any(Object));
        expect(pill().textContent).toBe(word);
        expect(pill().className).toBe(`vfx-pill ${statusClass}`);
        expect(pill().style.display).toBe('');
    });

    it('probes nothing while no page shows the pill', async () => {
        document.body.innerHTML = '';
        await refreshHealthPill();
        expect(host.probeBackendHealth).not.toHaveBeenCalled();
    });
});
