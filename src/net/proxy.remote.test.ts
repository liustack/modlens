import * as http from 'http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as zlib from 'zlib';
import { resolveProviderSettings } from '../config.ts';
import { apiFetch } from './proxy.ts';

// The point of this file is what it does NOT mock: undici. The sibling
// provider suites stub global fetch, which cannot catch host fetch being
// used on the no-proxy path, the defect of issue #91. Here apiFetch runs
// through the real npm undici fetch against a real local HTTP/1.1 server.
const GZIP_PAYLOAD = { hello: 'world', n: 1 };
const PLAIN_PAYLOAD = { ok: true };
let port = 0;

let server: http.Server;

beforeAll(async () => {
    const gzipped = zlib.gzipSync(JSON.stringify(GZIP_PAYLOAD));
    server = http.createServer((req, res) => {
        if (req.url === '/gzip') {
            res.writeHead(200, {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
                'content-length': String(gzipped.length),
            });
            res.end(gzipped);
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(PLAIN_PAYLOAD));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

afterAll(() => {
    server.close();
});

describe('apiFetch over the real undici stack (#91)', () => {
    it('decompresses gzip JSON on the npm undici path with no proxy', async () => {
        const response = await apiFetch(
            `http://127.0.0.1:${port}/gzip`,
            { method: 'GET' },
            undefined,
        );
        expect(await response.json()).toEqual(GZIP_PAYLOAD);
    });

    it('never calls host fetch when no proxy is configured', async () => {
        vi.stubGlobal('fetch', () => {
            throw new Error('host fetch must not run');
        });
        const response = await apiFetch(
            `http://127.0.0.1:${port}/plain`,
            { method: 'GET' },
            undefined,
        );
        expect(await response.json()).toEqual(PLAIN_PAYLOAD);
    });
});

describe('provider direct routing over real connections (#97)', () => {
    it.each(['config', 'env'] as const)(
        'keeps an internal provider reachable when the shared %s proxy fails',
        async (source) => {
            let proxyAttempts = 0;
            const failedProxy = http.createServer((_req, res) => {
                proxyAttempts += 1;
                res.destroy();
            });
            failedProxy.on('connect', (_req, socket) => {
                proxyAttempts += 1;
                socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            });
            await new Promise<void>((resolve) => failedProxy.listen(0, '127.0.0.1', resolve));
            const proxyPort = (failedProxy.address() as { port: number }).port;
            const proxyUrl = `http://127.0.0.1:${proxyPort}`;
            for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
                vi.stubEnv(name, source === 'env' ? proxyUrl : '');
            }
            vi.stubEnv('NO_PROXY', '');
            vi.stubEnv('no_proxy', '');
            const config = {
                ...(source === 'config' ? { proxy: proxyUrl } : {}),
                providers: { 'gemini-api': {}, openai: { proxy: '' } },
            };
            const request = (provider: string) =>
                apiFetch(
                    `http://127.0.0.1:${port}/plain`,
                    { method: 'GET', signal: AbortSignal.timeout(2_000) },
                    resolveProviderSettings(provider, config).proxy,
                );
            try {
                await expect(request('gemini-api')).rejects.toThrow();
                expect(proxyAttempts).toBeGreaterThan(0);
                const attemptsBeforeDirect = proxyAttempts;
                const response = await request('openai');
                expect(await response.json()).toEqual(PLAIN_PAYLOAD);
                expect(proxyAttempts).toBe(attemptsBeforeDirect);
            } finally {
                await new Promise<void>((resolve, reject) => {
                    failedProxy.close((error) => (error ? reject(error) : resolve()));
                });
            }
        },
    );
});
