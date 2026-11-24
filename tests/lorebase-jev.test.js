/**
 * LoreBase's Fast and Cheap [Jev] connection (src/features/lorebase/lorebase-jev.js, plan D16 of InternalProject/Vectfox/
 * plans/executed/lorebook-semantic-overhaul-passage-index.md): Jev runs on the OpenRouter or Custom profile chosen for it; VectFox
 * sends Similharity's decisions route the profile's source, URL, model and key ID, never a key; each setup that cannot
 * run says what is wrong, then what that costs (connectionConsequence, a stand-in here: lorebase-connection.test.js
 * covers it); a refusal says what Similharity answered; each call is reported once it ends, as LoreBase's, with no key
 * ID; and Test connection asks one made-up question. The real profile wrapper reads a stand-in for SillyTavern's
 * context.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ connectionConsequence: null }));

vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/sillytavern/requests.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'session' }) }));
vi.mock('../src/features/lorebase/lorebase-connection.js', () => ({ connectionConsequence: (...args) => host.connectionConsequence(...args) }));
// The real report of finished calls, which is all of the barrel this file reaches.
vi.mock('../src/features/llm-provider/index.js', () => vi.importActual('../src/features/llm-provider/llm-call-report.js'));

const { askJev, resolveJevConnection, testJevConnection } = await import('../src/features/lorebase/lorebase-jev.js');
const { setLlmCallFinishedListener } = await import('../src/features/llm-provider/llm-call-report.js');

const PROFILES = [
    { id: 'p-or', name: 'Jev on OpenRouter', api: 'openrouter', model: 'typesafe/jev-1.14', 'secret-id': 'or-jev' },
    { id: 'p-ts', name: 'Jev on Typesafe', api: 'custom', model: 'jev-1.14.0', 'api-url': 'https://api.typesafe.ai/v1', 'secret-id': 'ts-jev' },
    { id: 'p-claude', name: 'Claude', api: 'claude', model: 'claude-opus-5-5' },
    { id: 'p-no-model', name: 'No model', api: 'openrouter', model: '' },
    { id: 'p-no-url', name: 'No URL', api: 'custom', model: 'jev-1.14.0' },
];
const STATE = "The chat so far. The last message is the user's; the next reply answers it.\n\nWren: Who keeps the lamp?";
const QUESTIONS = { e1: { type: 'noul', instructions: 'Does the next reply need the lorebook entry "Lighthouse" (about: lamp)?' } };

const OUT_OF_REPLIES = 'Until then the entries selected for LoreBase stay out of replies.';
const WHERE_TO_FIX = 'Choose one in the Jev group of the LoreBase model card on the WorldInfo page.';

beforeEach(() => {
    host.connectionConsequence = vi.fn(() => OUT_OF_REPLIES);
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { connectionManager: { profiles: PROFILES } },
            CONNECT_API_MAP: {
                openrouter: { selected: 'openai', source: 'openrouter' },
                custom: { selected: 'openai', source: 'custom' },
                claude: { selected: 'openai', source: 'claude' },
            },
        }),
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ yes: { e1: 0.37 }, inputTokens: 40, usd: 0.000014 }) }));
    setLlmCallFinishedListener(null);
});

describe("Jev's connection", () => {
    it("sends an OpenRouter profile's source, model and key ID, never a URL or a key", async () => {
        const connection = resolveJevConnection({ lorebase_jev_connection_profile_id: 'p-or' });
        expect(connection).toEqual({ ok: true, fields: { source: 'openrouter', model: 'typesafe/jev-1.14', secret_id: 'or-jev' }, profileName: 'Jev on OpenRouter' });

        const answer = await askJev(connection, STATE, QUESTIONS);
        expect(answer).toEqual({ yes: { e1: 0.37 }, inputTokens: 40, usd: 0.000014 });
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('/api/plugins/similharity/lorebase/decisions');
        expect(JSON.parse(init.body)).toEqual({ source: 'openrouter', model: 'typesafe/jev-1.14', secret_id: 'or-jev', state: STATE, questions: QUESTIONS });
        expect(init.headers).not.toHaveProperty('Authorization');
    });

    it("sends a Custom profile's URL with its model and key ID", () => {
        expect(resolveJevConnection({ lorebase_jev_connection_profile_id: 'p-ts' })).toEqual({
            ok: true, fields: { source: 'custom', model: 'jev-1.14.0', apiUrl: 'https://api.typesafe.ai/v1', secret_id: 'ts-jev' },
            profileName: 'Jev on Typesafe',
        });
    });

    it('says what keeps the chosen setup from running', () => {
        const problem = id => resolveJevConnection({ lorebase_jev_connection_profile_id: id }).problem;
        expect(problem('')).toContain('Fast and Cheap [Jev] has no profile for Jev');
        expect(problem('p-deleted')).toContain("Jev's profile is no longer in SillyTavern");
        expect(problem('p-claude')).toContain('is neither an OpenRouter nor a Custom profile');
        expect(problem('p-no-model')).toContain('names no model');
        expect(problem('p-no-url')).toContain('names no URL');
        expect(problem('')).toBe(`Fast and Cheap [Jev] has no profile for Jev. ${WHERE_TO_FIX} ${OUT_OF_REPLIES}`);
        expect(host.connectionConsequence).toHaveBeenCalledWith({ lorebase_jev_connection_profile_id: '' }, { isJev: true });
    });

    it('ends on what is wrong when it costs nothing now, as while LoreBase is off', () => {
        host.connectionConsequence = vi.fn(() => '');
        const problem = id => resolveJevConnection({ lorebase_jev_connection_profile_id: id }).problem;
        expect(problem('')).toBe(`Fast and Cheap [Jev] has no profile for Jev. ${WHERE_TO_FIX}`);
        expect(problem('p-no-url')).toBe(`Jev's Custom profile "No URL" names no URL.`);
    });

    it('says what Similharity answered when Jev cannot answer', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '{"error":"Jev on OpenRouter: 401 Unauthorized (the server refused the API key)"}' }));
        await expect(askJev({ fields: { source: 'openrouter', model: 'typesafe/jev-1.14' }, profileName: 'Jev on OpenRouter' }, STATE, QUESTIONS))
            .rejects.toThrow('Jev could not answer through Similharity (HTTP 502): {"error":"Jev on OpenRouter: 401 Unauthorized (the server refused the API key)"}');
    });
});

describe("the report of Jev's calls", () => {
    const reports = [];
    const connection = () => resolveJevConnection({ lorebase_jev_connection_profile_id: 'p-or' });
    beforeEach(() => {
        reports.length = 0;
        setLlmCallFinishedListener(call => reports.push(call));
    });

    it("names LoreBase, the profile, Jev's model and the prompt tokens Jev counted, and no key ID", async () => {
        await askJev(connection(), STATE, QUESTIONS);
        expect(reports).toHaveLength(1);
        const [report] = reports;
        expect(report).toEqual({
            feature: 'lorebase', connection: 'profile', profileName: 'Jev on OpenRouter', provider: 'openrouter', model: 'typesafe/jev-1.14',
            durationMs: expect.any(Number), outcome: 'ok',
            usage: { prompt_tokens: 40, completion_tokens: null, total_tokens: null, cached_tokens: null },
        });
        expect(JSON.stringify(report)).not.toContain('or-jev');
    });

    it('says a refused call failed, with no tokens, and one that ran out of time timed out', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => 'refused' }));
        await expect(askJev(connection(), STATE, QUESTIONS)).rejects.toThrow('HTTP 502');
        globalThis.fetch = vi.fn(async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
        await expect(askJev(connection(), STATE, QUESTIONS)).rejects.toThrow('timed out');
        expect(reports.map(({ outcome, usage }) => ({ outcome, usage }))).toEqual([
            { outcome: 'failed', usage: null },
            { outcome: 'timed-out', usage: null },
        ]);
    });

    it('reports no tokens when Jev counted none', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ yes: { e1: 0.2 }, inputTokens: null, usd: null }) }));
        await askJev(connection(), STATE, QUESTIONS);
        expect(reports[0].usage).toBeNull();
    });
});

describe("Jev's Test connection", () => {
    it('asks one made-up question on the chosen profile and says how Jev rated it', async () => {
        const result = await testJevConnection({ lorebase_jev_connection_profile_id: 'p-or' });
        expect(result).toEqual({ content: 'Jev rated a made-up entry at 0.37, for $0.000014.', cutReason: null });
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.state).toContain('harbor lighthouse');
        expect(Object.keys(body.questions)).toEqual(['e1']);
    });

    it('fails with the setup problem before any request', async () => {
        await expect(testJevConnection({ lorebase_jev_connection_profile_id: 'p-claude' })).rejects.toThrow('neither an OpenRouter nor a Custom profile');
        expect(fetch).not.toHaveBeenCalled();
    });
});
