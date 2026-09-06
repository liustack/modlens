import { EnvHttpProxyAgent, ProxyAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiProxyDispatcher, connectFailureHint } from './proxy.ts';

// Production apiFetch always uses npm undici fetch. Tests bridge it back to
// the global fetch so a stub can stand in for a truncated body.
vi.mock('undici', async (importOriginal) => {
    const real = await importOriginal<typeof import('undici')>();
    return {
        ...real,
        fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('apiProxyDispatcher', () => {
    it('returns undefined when nothing configures a proxy', () => {
        expect(apiProxyDispatcher(undefined, {})).toBeUndefined();
    });

    it('builds a ProxyAgent for an explicit proxy setting', () => {
        const dispatcher = apiProxyDispatcher('http://127.0.0.1:7890', {});
        expect(dispatcher).toBeInstanceOf(ProxyAgent);
    });

    it('honors the standard env vars when no explicit proxy is set', () => {
        for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
            const dispatcher = apiProxyDispatcher(undefined, { [name]: 'http://127.0.0.1:1' });
            expect(dispatcher, name).toBeInstanceOf(EnvHttpProxyAgent);
        }
    });

    it('uses a direct connection when the provider explicitly sets an empty proxy (#97)', () => {
        const dispatcher = apiProxyDispatcher('', { HTTPS_PROXY: 'http://127.0.0.1:1' });
        expect(dispatcher).toBeUndefined();
    });

    it('prefers the explicit setting over env vars', () => {
        const dispatcher = apiProxyDispatcher('http://10.0.0.9:8080', {
            HTTPS_PROXY: 'http://127.0.0.1:1',
        });
        expect(dispatcher).toBeInstanceOf(ProxyAgent);
    });
});

describe('connectFailureHint', () => {
    const connectError = new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });

    it('turns an opaque connect failure into an actionable proxy hint', () => {
        const hint = connectFailureHint(
            connectError,
            'https://generativelanguage.googleapis.com/v1beta/x',
        );
        expect(hint).toContain('generativelanguage.googleapis.com');
        expect(hint).toContain('HTTPS_PROXY');
        expect(hint).toContain('config set proxy');
    });

    it('stays silent for non-network errors', () => {
        expect(connectFailureHint(new Error('bad json'), 'https://x.example')).toBeNull();
        expect(connectFailureHint(new TypeError('fetch failed'), 'not a url')).toBeNull();
    });
});

describe('apiFetch body read after headers', () => {
    it('keeps status readable and rejects body methods on a truncated 401', async () => {
        const reset = Object.assign(new Error('aborted'), { cause: { code: 'ECONNRESET' } });
        vi.stubGlobal('fetch', async () => ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: new Headers({ 'content-type': 'text/plain' }),
            arrayBuffer: async () => {
                throw reset;
            },
        }));

        const response = await apiFetch(
            'https://generativelanguage.googleapis.com/v1beta/x',
            { method: 'GET' },
            undefined,
        );
        expect(response.status).toBe(401);
        expect(response.ok).toBe(false);
        expect(response.headers.get('content-type')).toBe('text/plain');
        await expect(response.clone().text()).rejects.toBe(reset);
        await expect(response.clone().json()).rejects.toBe(reset);
    });
});
