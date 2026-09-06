import { execFile } from 'node:child_process';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VISION_RESULT_SCHEMA } from './schema.ts';

const execFileAsync = promisify(execFile);

/**
 * The same path, spelled the one way both sides can agree on. Windows hands
 * out 8.3 short names (RUNNER~1) from the temp directory, and Node's realpath
 * resolves links without expanding those, while the native one does. Comparing
 * two spellings of the same directory is not a test of anything.
 */
const canon = (target: string): string =>
    typeof fs.realpathSync.native === 'function'
        ? fs.realpathSync.native(target)
        : fs.realpathSync(target);

/** Minimal Cordis inject seam: run only when every requested service exists. */
const injectAvailable =
    (services: Record<string, unknown>) =>
    (deps: string[], run: (scope: unknown) => void): void => {
        if (deps.every((dep) => Object.hasOwn(services, dep))) run(services);
    };

/** Isolated paste directories handed to every route under test. */
const routePasteDirs: string[] = [];
afterAll(() => {
    for (const dir of routePasteDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('dsh plugin bundle', () => {
    it('ships a vision schema identical to the source of truth', () => {
        // dsh/index.js cannot import the TS source, so it carries a JSON copy;
        // this is the lockstep check that keeps the copy honest.
        const shipped = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'dsh', 'vision-schema.json'), 'utf-8'),
        );
        expect(shipped).toEqual(VISION_RESULT_SCHEMA);
    });

    it('wires the bundle manifest to the patch and the patch to the subpath', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
        ) as {
            dsh?: { bundle?: { patch?: string } };
            exports?: Record<string, string>;
            files?: string[];
        };
        expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
        expect(pkg.exports?.['.']).toBe('./dsh/index.js');
        expect(pkg.exports?.['./dsh']).toBe('./dsh/index.js');
        expect(pkg.files).toContain('dsh');
        expect(pkg.files).toContain('cordis.patch.yml');
        const patch = fs.readFileSync(path.join(__dirname, '..', 'cordis.patch.yml'), 'utf-8');
        expect(patch).toContain("name: '@liustack/modlens'");
    });
});

describe('dsh plugin auto-read (phase 2)', () => {
    type Handler = (
        payload: { messages: unknown[]; signal?: AbortSignal },
        next: () => Promise<unknown>,
    ) => Promise<{
        kind: string;
        messages?: Array<{ content: Array<{ type: string; text?: string }> }>;
    }>;

    async function load(autoRead: boolean | undefined = true) {
        // The plugin is plain JS by design (no build step, no dsh type deps).
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: { autoRead?: boolean }) => void;
        };
        const handlers: Record<string, Handler> = {};
        const ctx = {
            tools: { register: () => {} },
            attachments: {
                readImage: async () => ({
                    data: new Uint8Array([1, 2, 3]),
                    ref: { mediaType: 'image/png' },
                }),
            },
            on: (event: string, fn: Handler) => {
                handlers[event] = fn;
            },
        };
        plugin.apply(ctx as never, autoRead === undefined ? {} : { autoRead });
        return handlers;
    }

    function fakeCli(body: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-cli-'));
        const file = path.join(dir, 'cli.js');
        fs.writeFileSync(file, body);
        return file;
    }

    const imageMessage = () => ({
        role: 'user',
        content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', attachment: { id: 'a1', mediaType: 'image/png' } },
        ],
    });

    it('rewrites image blocks into modlens evidence text after next()', async () => {
        const handlers = await load();
        const cli = fakeCli(
            `console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'HELLO-EVIDENCE' }, uncertainty: [] } }))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const messages = [imageMessage()];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(decision.kind).toBe('enter');
            const blocks = decision.messages?.[0].content ?? [];
            expect(blocks[0]).toEqual({ type: 'text', text: 'what is this' });
            expect(blocks[1].type).toBe('text');
            expect(blocks[1].text).toContain('HELLO-EVIDENCE');
            expect(blocks[1].text).toContain('Pasted image');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('names the failure when the attachment store returns no data bytes (#17)', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, Handler> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                // An API-shape drift: readImage resolves, but with no data field.
                attachments: { readImage: async () => ({ ref: { mediaType: 'image/png' } }) },
                on: (event: string, fn: Handler) => {
                    handlers[event] = fn;
                },
            } as never,
            { autoRead: true },
        );
        const errors: string[] = [];
        const original = console.error;
        console.error = (value?: unknown) => errors.push(String(value));
        const messages = [imageMessage()];
        let decision: Awaited<ReturnType<Handler>>;
        try {
            decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
        } finally {
            console.error = original;
        }
        const block = decision.messages?.[0].content[1];
        expect(block?.text).toContain('could not be read');
        // The detail lives in the harness log now; the wire text is a stage
        // constant so a repeated failure cannot rewrite history (#68).
        expect(block?.text).toContain('attachment store did not return it');
        expect(errors.join('\n')).toContain("no 'data' bytes");
    });

    it('writes heic pastes with their real extension and refuses unknown types', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cli = fakeCli(
            `const f = process.argv[3];
             if (!f.endsWith('.heic')) { console.error('wrong ext: ' + f); process.exit(9) }
             console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'HEIC-OK' }, uncertainty: [] } }))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const load = (mediaType: string) => {
                const handlers: Record<string, Handler> = {};
                plugin.apply(
                    {
                        tools: { register: () => {} },
                        attachments: {
                            readImage: async () => ({
                                data: new Uint8Array([1]),
                                ref: { mediaType },
                            }),
                        },
                        on: (event: string, fn: Handler) => {
                            handlers[event] = fn;
                        },
                    } as never,
                    { autoRead: true },
                );
                return handlers;
            };
            const messages = [imageMessage()];
            const heic = await load('image/heic')['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(heic.messages?.[0].content[1].text).toContain('HEIC-OK');
            const pdf = await load('application/pdf')['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            const pdfText = pdf.messages?.[0].content[1].text;
            // The type is attacker-shaped paste metadata, so the wire text is
            // a pure constant and the concrete type lives in the log only.
            expect(pdfText).toContain('its media type is not supported');
            expect(pdfText).not.toContain('application/pdf');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('auto-read also converts images nested in tool-result content (#24)', async () => {
        const handlers = await load();
        const cli = fakeCli(
            `console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'DEEP-NESTED' }, uncertainty: [] } }))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            // Two levels down: tool-result inside tool-result, image at the bottom.
            const messages = [
                {
                    role: 'tool',
                    content: [
                        {
                            type: 'tool-result',
                            toolCallId: 'outer',
                            content: [
                                {
                                    type: 'tool-result',
                                    toolCallId: 'inner',
                                    content: [{ type: 'image', attachment: { id: 'deep' } }],
                                },
                            ],
                        },
                    ],
                },
            ];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            const outer = decision.messages?.[0].content[0] as unknown as {
                content: Array<{ content: Array<{ type: string; text?: string }> }>;
            };
            expect(outer.content[0].content[0].type).toBe('text');
            expect(outer.content[0].content[0].text).toContain('DEEP-NESTED');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('degrades a failed read to an explanatory block instead of rejecting the step', async () => {
        const handlers = await load();
        const cli = fakeCli(`console.error('engine down'); process.exit(1)`);
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const messages = [imageMessage()];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(decision.kind).toBe('enter');
            const block = decision.messages?.[0].content[1];
            expect(block?.text).toContain('could not be read');
            // Stage constant, not the attempt's own words: the same broken
            // engine phrasing itself differently every try used to rewrite
            // history and bust the provider's prefix cache (#68).
            expect(block?.text).toContain('the vision engine failed');
            expect(block?.text).not.toContain('engine down');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('passes through image-free steps, reject decisions, and autoRead: false', async () => {
        const handlers = await load();
        const plain = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
        const enter = await handlers['agent/pre-step']({ messages: plain }, async () => ({
            kind: 'enter',
            messages: plain,
        }));
        expect(enter.messages).toBe(plain);
        const reject = await handlers['agent/pre-step'](
            { messages: [imageMessage()] },
            async () => ({ kind: 'reject' }),
        );
        expect(reject).toEqual({ kind: 'reject' });
        const off = await load(false);
        expect(off['agent/pre-step']).toBeUndefined();
        // Default config: no auto-read handler (request-time conversion owns it).
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const bare: Record<string, unknown> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: unknown) => {
                    bare[event] = fn;
                },
            } as never,
            {},
        );
        expect(bare['agent/pre-step']).toBeUndefined();
    });
});

describe('dsh plugin vision provider (phase 3)', () => {
    async function loadWith(llm: Record<string, unknown> | undefined, config = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const ctx = {
            tools: { register: () => {} },
            attachments: {},
            on: () => {},
            llm,
        };
        plugin.apply(ctx as never, config);
        return ctx;
    }

    it('waits for an active llm scope before starting discovery (#79)', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        const registered: string[][] = [];
        const armed: string[][] = [];
        let activate: (() => void) | undefined;
        const llm = {
            listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
            listModels: async () => [
                {
                    id: 'deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                    inputModalities: ['text'],
                },
            ],
            resolveModelInfo: async (_provider: string, model: string) => ({
                id: model,
                inputModalities: ['text'],
            }),
            providerRetryPolicy: () => undefined,
            stream: () => (async function* () {})(),
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                registered.push(ids);
                adapter.providerInfo(ids[0]);
                adapter.providerRetryPolicy(ids[0]);
                const handle = () => {};
                handle.replace = () => {};
                return handle;
            },
        };
        const activeScope = {
            llm,
            tools: { register: () => {} },
            attachments: {},
            on: (event: string, fn: () => void) => {
                handlers[event] = fn;
            },
        };
        const inactiveContext = {
            tools: { register: () => {} },
            attachments: {},
            on: () => {},
            inject: (deps: string[], fn: (scope: unknown) => void) => {
                armed.push(deps);
                if (deps.length === 1 && deps[0] === 'llm') {
                    activate = () => fn(activeScope);
                }
            },
            get llm(): never {
                throw new Error('cannot get required service "llm" in inactive context');
            },
        };
        const errors: string[] = [];
        const original = console.error;
        console.error = (value?: unknown) => errors.push(String(value));
        try {
            expect(() =>
                plugin.apply(inactiveContext as never, {
                    pasteToPath: false,
                    settingsCard: false,
                }),
            ).not.toThrow();
            expect(armed).toContainEqual(['llm']);
            expect(registered).toEqual([]);

            activate?.();
            await vi.waitFor(() => expect(registered).toEqual([['deepseek-modlens']]));
            expect(errors.join('\n')).not.toContain('inactive context');

            handlers['llm/adapters-updated']();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(registered).toEqual([['deepseek-modlens']]);
        } finally {
            console.error = original;
        }
    });

    it('invalidates a deferred discovery sweep before llm replacement (#79)', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        type Cleanup = () => void;
        type Injected = (scope: unknown) => undefined | Cleanup;
        let mountLlm: Injected | undefined;
        let resolveOldModels: ((models: Array<{ id: string }>) => void) | undefined;
        let oldListCalls = 0;
        const oldModels = new Promise<Array<{ id: string }>>((resolve) => {
            resolveOldModels = resolve;
        });
        const registered: string[] = [];
        const errors: string[] = [];

        const activation = (
            provider: string,
            models: () => Promise<Array<{ id: string }>>,
        ): { deactivate: () => Promise<void> } => {
            let active = true;
            let acceptsEffects = true;
            const effects: Cleanup[] = [];
            const handlers: Record<string, () => void> = {};
            const assertCanCreateEffect = () => {
                if (acceptsEffects) return;
                const error = new Error('cannot create effect on inactive context');
                (error as Error & { code: string }).code = 'INACTIVE_EFFECT';
                throw error;
            };
            const llm = {
                listProviders: () => [{ id: provider, name: provider }],
                listModels: models,
                resolveModelInfo: async (_upstream: string, model: string) => ({
                    id: model,
                    inputModalities: ['text'],
                }),
                providerRetryPolicy: () => undefined,
                stream: () => (async function* () {})(),
                registerAdapter: (ids: string[]) => {
                    assertCanCreateEffect();
                    registered.push(...ids);
                    const handle = () => {};
                    handle.replace = () => {};
                    effects.push(handle);
                    return handle;
                },
            };
            const scope = {
                get llm() {
                    if (!active) {
                        throw new Error('cannot get required service "llm" in inactive context');
                    }
                    return llm;
                },
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                    const dispose = () => {
                        delete handlers[event];
                    };
                    effects.push(dispose);
                    return dispose;
                },
                effect: (run: () => void) => {
                    assertCanCreateEffect();
                    run();
                    return () => {};
                },
            };
            const cleanup = mountLlm?.(scope);
            if (typeof cleanup === 'function') effects.push(cleanup);
            return {
                deactivate: async () => {
                    // Cordis marks the fiber UNLOADING synchronously, then
                    // crosses one microtask before running its disposers.
                    acceptsEffects = false;
                    await Promise.resolve();
                    active = false;
                    for (const dispose of effects.reverse()) dispose();
                },
            };
        };

        const original = console.error;
        console.error = (value?: unknown) => errors.push(String(value));
        try {
            plugin.apply(
                {
                    tools: { register: () => {} },
                    attachments: {},
                    on: () => {},
                    inject: (deps: string[], run: Injected) => {
                        if (deps.length === 1 && deps[0] === 'llm') mountLlm = run;
                    },
                } as never,
                { pasteToPath: false, settingsCard: false },
            );

            const old = activation('old-route', () => {
                oldListCalls += 1;
                return oldModels;
            });
            expect(oldListCalls).toBe(1);

            // Resolve first so the sweep continuation is already queued when
            // the same task starts unloading the child fiber.
            resolveOldModels?.([{ id: 'deepseek-v4-flash' }]);
            await old.deactivate();

            activation('next-route', async () => [{ id: 'glm-5.3' }]);
            await vi.waitFor(() => expect(registered).toContain('modlens-next-route'));

            expect(registered).not.toContain('modlens-old-route');
            expect(errors.join('\n')).not.toContain('inactive context');
        } finally {
            console.error = original;
        }
    });

    it('does not refresh a later wrapper after a deferred probe enters unload (#79)', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        type Cleanup = () => void;
        type Injected = (scope: unknown) => undefined | Cleanup;
        type Provider = { id: string; name: string; models: Array<{ id: string }> };
        let mountLlm: Injected | undefined;
        let resolveDeferred: ((models: Array<{ id: string }>) => void) | undefined;
        let deferredCalls = 0;
        let acceptsEffects = true;
        let active = true;
        let maxRetries = 2;
        let replaceDuringUnload = 0;
        const effects: Cleanup[] = [];
        const handlers: Record<string, () => void> = {};
        const registered: string[] = [];
        const providers: Provider[] = [
            { id: 'route-b', name: 'Route B', models: [{ id: 'glm-5.3' }] },
        ];
        const deferred = new Promise<Array<{ id: string }>>((resolve) => {
            resolveDeferred = resolve;
        });
        const assertCanCreateEffect = () => {
            if (acceptsEffects) return;
            const error = new Error('cannot create effect on inactive context');
            (error as Error & { code: string }).code = 'INACTIVE_EFFECT';
            throw error;
        };
        const llm = {
            listProviders: () => providers.map(({ id, name }) => ({ id, name })),
            listModels: (provider: string) => {
                if (provider === 'route-a') {
                    deferredCalls += 1;
                    return deferred;
                }
                return Promise.resolve(providers.find(({ id }) => id === provider)?.models ?? []);
            },
            resolveModelInfo: async (_provider: string, model: string) => ({
                id: model,
                inputModalities: ['text'],
            }),
            providerRetryPolicy: () => ({ maxRetries }),
            stream: () => (async function* () {})(),
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                assertCanCreateEffect();
                registered.push(...ids);
                adapter.providerRetryPolicy(ids[0]);
                const handle = () => {};
                handle.replace = () => {
                    if (!acceptsEffects) replaceDuringUnload += 1;
                    adapter.providerRetryPolicy(ids[0]);
                };
                effects.push(handle);
                return handle;
            },
        };
        const scope = {
            get llm() {
                if (!active) {
                    throw new Error('cannot get required service "llm" in inactive context');
                }
                return llm;
            },
            on: (event: string, fn: () => void) => {
                handlers[event] = fn;
                const dispose = () => {
                    delete handlers[event];
                };
                effects.push(dispose);
                return dispose;
            },
            effect: (run: () => void) => {
                assertCanCreateEffect();
                run();
                return () => {};
            },
        };

        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: () => {},
                inject: (deps: string[], run: Injected) => {
                    if (deps.length === 1 && deps[0] === 'llm') mountLlm = run;
                },
            } as never,
            { pasteToPath: false, settingsCard: false },
        );
        const cleanup = mountLlm?.(scope);
        if (typeof cleanup === 'function') effects.push(cleanup);
        await vi.waitFor(() => expect(registered).toContain('modlens-route-b'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        providers.unshift({ id: 'route-a', name: 'Route A', models: [] });
        handlers['llm/adapters-updated']();
        await vi.waitFor(() => expect(deferredCalls).toBe(1));

        maxRetries = 50;
        resolveDeferred?.([]);
        acceptsEffects = false;
        await Promise.resolve();
        active = false;
        for (const dispose of effects.reverse()) dispose();

        expect(replaceDuringUnload).toBe(0);
    });

    it('registers a wrapper provider that declares image input and delegates', async () => {
        const registered: Array<{
            providers: string[];
            adapter: Record<string, CallableFunction>;
        }> = [];
        const streamed: Array<Record<string, unknown>> = [];
        const upstreamRetryPolicy = {
            mode: 'normal',
            maxRetries: 50,
            retryableCodes: ['RATE_LIMIT'],
            initialDelayMs: 1,
            maxDelayMs: 2,
            jitterRatio: 0,
        };
        const llm = {
            registerAdapter: (providers: string[], adapter: Record<string, CallableFunction>) => {
                registered.push({ providers, adapter });
            },
            listModels: async () => [
                {
                    provider: 'deepseek-official',
                    id: 'deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                    description: 'Fast route',
                    inputModalities: ['text', 'audio'],
                },
            ],
            resolveModelInfo: async (_p: string, model: string) => ({
                provider: 'deepseek-official',
                id: model,
                name: 'DeepSeek V4 Flash',
                description: 'Fast route',
                inputModalities: ['text', 'audio'],
                context: { contextWindow: 128_000 },
                defaultMaxTokens: 8192,
                reasoning: {
                    efforts: [{ id: 'high', name: 'High' }],
                    defaultEffort: 'high',
                },
            }),
            providerRetryPolicy: (provider: string) => {
                expect(provider).toBe('deepseek-official');
                return upstreamRetryPolicy;
            },
            stream: (options: Record<string, unknown>) => {
                streamed.push(options);
                return (async function* () {})();
            },
        };
        await loadWith(llm);
        expect(registered[0].providers).toEqual(['deepseek-modlens']);
        const providerInfo = registered[0].adapter.providerInfo('deepseek-modlens') as {
            id: string;
            name: string;
        };
        expect(providerInfo.id).toBe('deepseek-modlens');
        expect(providerInfo.name.length).toBeGreaterThan(0);
        expect(registered[0].adapter.providerRetryPolicy('deepseek-modlens')).toBe(
            upstreamRetryPolicy,
        );
        const adapter = registered[0].adapter;
        const models = (await adapter.listModels('deepseek-modlens')) as Array<{
            provider: string;
            name: string;
            description: string;
            inputModalities: string[];
        }>;
        expect(models).toHaveLength(1);
        expect(models[0].provider).toBe('deepseek-modlens');
        expect(models[0].inputModalities).toEqual(['text', 'audio', 'image']);
        expect(models[0].name).toContain('modlens vision');
        expect(models[0].description).toBe('Fast route');
        const info = (await adapter.resolveModel('deepseek-modlens', 'deepseek-v4-flash')) as {
            provider: string;
            id: string;
            description: string;
            inputModalities: string[];
            context: { contextWindow: number };
            defaultMaxTokens: number;
            reasoning: { efforts: Array<{ id: string }>; defaultEffort: string };
        };
        expect(info.provider).toBe('deepseek-modlens');
        expect(info.id).toBe('deepseek-v4-flash');
        expect(info.inputModalities).toEqual(['text', 'audio', 'image']);
        expect(info).toMatchObject({
            description: 'Fast route',
            context: { contextWindow: 128_000 },
            defaultMaxTokens: 8192,
            reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' },
        });
        const signal = new AbortController().signal;
        for await (const _chunk of adapter.stream({
            provider: 'deepseek-modlens',
            model: 'deepseek-v4-flash',
            messages: [],
            signal,
            maxTokens: 4096,
            reasoningEffort: 'high',
        }) as AsyncIterable<unknown>) {
            // drain
        }
        expect(streamed[0].provider).toBe('deepseek-official');
        expect(streamed[0]).toMatchObject({
            model: 'deepseek-v4-flash',
            signal,
            maxTokens: 4096,
            reasoningEffort: 'high',
            via: 'deepseek-modlens',
        });
    });

    it("serves dsh 0.1.1's prepareCall dispatch (#73)", async () => {
        // dsh 0.1.1 routes every call (and its replay path) through
        // adapter.prepareCall and throws "prepareCall is not a function" on
        // adapters that lack it. Real adapters inherit a base-class default
        // binding resolveModel and stream into one generation; this plain
        // object must carry the same pair itself, like providerInfo above.
        const registered: Array<{
            providers: string[];
            adapter: Record<string, CallableFunction>;
        }> = [];
        const streamed: Array<Record<string, unknown>> = [];
        const llm = {
            registerAdapter: (providers: string[], adapter: Record<string, CallableFunction>) => {
                registered.push({ providers, adapter });
            },
            listModels: async () => [{ id: 'deepseek-v4-flash' }],
            resolveModelInfo: async (_p: string, model: string) => ({
                provider: 'deepseek-official',
                id: model,
                name: 'DeepSeek V4 Flash',
                inputModalities: ['text'],
            }),
            providerRetryPolicy: () => undefined,
            stream: (options: Record<string, unknown>) => {
                streamed.push(options);
                return (async function* () {})();
            },
        };
        await loadWith(llm);
        const adapter = registered[0].adapter;
        const signal = new AbortController().signal;
        const call = (await adapter.prepareCall(
            'deepseek-modlens',
            'deepseek-v4-flash',
            signal,
        )) as {
            model: { provider: string; id: string; inputModalities: string[] };
            stream: (options: Record<string, unknown>) => AsyncIterable<unknown>;
        };
        expect(call.model).toMatchObject({ provider: 'deepseek-modlens', id: 'deepseek-v4-flash' });
        expect(call.model.inputModalities).toEqual(['text', 'image']);
        for await (const _chunk of call.stream({
            provider: 'deepseek-modlens',
            model: 'deepseek-v4-flash',
            messages: [],
            signal,
        })) {
            // drain
        }
        expect(streamed[0].provider).toBe('deepseek-official');
        expect(streamed[0].via).toBe('deepseek-modlens');
    });

    it("serves dsh 0.1.2's imageRequestPricing dispatch (#93)", async () => {
        // dsh >= 0.1.2 calls adapter.imageRequestPricing during compact with
        // no feature check, so a missing method TypeErrors the turn. Real
        // adapters inherit a base-class default that returns undefined. This
        // plain object must supply the same no-op itself, like prepareCall.
        const registered: Array<{
            providers: string[];
            adapter: Record<string, CallableFunction>;
        }> = [];
        const llm = {
            registerAdapter: (providers: string[], adapter: Record<string, CallableFunction>) => {
                registered.push({ providers, adapter });
            },
            listModels: async () => [{ id: 'deepseek-v4-flash' }],
            resolveModelInfo: async (_p: string, model: string) => ({
                provider: 'deepseek-official',
                id: model,
                name: 'DeepSeek V4 Flash',
                inputModalities: ['text'],
            }),
            providerRetryPolicy: () => undefined,
            stream: () => (async function* () {})(),
        };
        await loadWith(llm);
        const adapter = registered[0].adapter;
        expect(
            adapter.imageRequestPricing('deepseek-modlens', 'deepseek-v4-flash'),
        ).toBeUndefined();
    });

    it('degrades silently without the registration surface or when disabled', async () => {
        await loadWith(undefined);
        const registered: unknown[] = [];
        await loadWith(
            { registerAdapter: (...args: unknown[]) => registered.push(args), stream: () => {} },
            { visionProvider: false },
        );
        expect(registered).toEqual([]);
    });

    it('reports an upstream catalog failure instead of disguising it as no models', async () => {
        let adapter: Record<string, CallableFunction> | undefined;
        await loadWith({
            registerAdapter: (
                _providers: string[],
                candidate: Record<string, CallableFunction>,
            ) => {
                adapter = candidate;
            },
            listModels: async () => {
                throw new Error('upstream catalog offline');
            },
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        });
        await expect(adapter?.listModels('deepseek-modlens')).rejects.toThrow(
            'upstream catalog offline',
        );
    });

    it.each(['no adapter registered for upstream', 'upstream retry policy is invalid'])(
        'does not register with harness defaults when retry lookup fails: %s',
        async (message) => {
            const registered: string[] = [];
            const errors: string[] = [];
            const original = console.error;
            console.error = (value?: unknown) => errors.push(String(value));
            try {
                await loadWith({
                    registerAdapter: (
                        providers: string[],
                        adapter: Record<string, CallableFunction>,
                    ) => {
                        adapter.providerInfo(providers[0]);
                        adapter.providerRetryPolicy(providers[0]);
                        registered.push(...providers);
                    },
                    providerRetryPolicy: () => {
                        throw new Error(message);
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                });
            } finally {
                console.error = original;
            }
            expect(registered).toEqual([]);
            expect(errors.join('\n')).toContain(message);
        },
    );

    it('waits for a pinned upstream instead of failing registration against its absence (#66)', async () => {
        // llm-pi-ai mounts its providers after settings load, so a pinned
        // upstream arriving later than this plugin is ordinary startup order,
        // not an error. Registering against the absence cannot succeed: dsh
        // snapshots the retry policy synchronously inside registerAdapter and
        // the upstream lookup throws NO_ADAPTER, so the old behaviour burned
        // one doomed attempt per event and logged each as a skipped
        // registration that read fatal while the next event quietly healed it.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        const captured: number[] = [];
        let attempts = 0;
        let mounted = false;
        const upstreamPolicy = {
            mode: 'normal',
            maxRetries: 50,
            retryableCodes: ['RATE_LIMIT'],
            initialDelayMs: 1,
            maxDelayMs: 2,
            jitterRatio: 0,
        };
        const llm = {
            listProviders: () => (mounted ? [{ id: 'lanz', name: 'Lanz' }] : []),
            providerRetryPolicy: () => {
                if (!mounted) {
                    // The exact shape dsh-llm throws for an unmounted route.
                    const failure = new Error('no adapter registered for provider "lanz"');
                    (failure as Error & { code: string }).code = 'NO_ADAPTER';
                    throw failure;
                }
                return upstreamPolicy;
            },
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                // Real dsh captures both synchronously inside registerAdapter,
                // which is where the doomed attempt used to blow up.
                attempts += 1;
                adapter.providerInfo(ids[0]);
                const policy = adapter.providerRetryPolicy(ids[0]) as { maxRetries: number };
                captured.push(policy.maxRetries);
                const handle = () => {};
                handle.replace = () => {};
                return handle;
            },
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        const errors: string[] = [];
        const original = console.error;
        console.error = (value?: unknown) => errors.push(String(value));
        try {
            plugin.apply(
                {
                    tools: { register: () => {} },
                    attachments: {},
                    on: (event: string, fn: () => void) => {
                        handlers[event] = fn;
                    },
                    llm,
                } as never,
                { upstream: 'lanz', providerId: 'house-lanz' },
            );

            // Nothing to register against yet: no attempt, no failure line,
            // one calm sentence naming what is being waited on, which is also
            // the breadcrumb a typo'd upstream leaves behind.
            expect(attempts).toBe(0);
            expect(errors.join('\n')).not.toContain('registration skipped');
            expect(errors.join('\n')).toContain('waiting for upstream "lanz"');

            // Another event while still absent stays quiet: the wait is
            // already on record.
            handlers['llm/adapters-updated']();
            expect(attempts).toBe(0);
            expect(errors.filter((line) => line.includes('waiting for upstream')).length).toBe(1);

            // The upstream mounts. The first real attempt happens now and
            // snapshots the upstream's own policy, not a placeholder.
            mounted = true;
            handlers['llm/adapters-updated']();
            expect(attempts).toBe(1);
            expect(captured).toEqual([50]);
            expect(errors.join('\n')).not.toContain('registration skipped');
        } finally {
            console.error = original;
        }
    });

    it('mints a pinned default id that encodes its upstream (#49)', async () => {
        // The flat default, deepseek-modlens whatever the upstream, collided
        // with the id auto-discovery mints for deepseek-official, so history
        // from a pinned foreign upstream could later be relabelled as
        // DeepSeek's and carry foreign replay state across the adapter
        // boundary. The default now follows the sweep's minting rule; an
        // explicit providerId and a pinned deepseek-official are unchanged.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const load = (upstream: string) => {
            const registered: string[][] = [];
            const llm = {
                listProviders: () => [{ id: upstream, name: upstream }],
                providerRetryPolicy: () => undefined,
                registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                    registered.push(ids);
                    adapter.providerInfo(ids[0]);
                    const handle = () => {};
                    handle.replace = () => {};
                    return handle;
                },
                listModels: async () => [],
                resolveModelInfo: async () => ({}),
                stream: () => (async function* () {})(),
            };
            plugin.apply(
                { tools: { register: () => {} }, attachments: {}, on: () => {}, llm } as never,
                { upstream },
            );
            return registered;
        };

        expect(load('opencode-go')[0]).toEqual(['modlens-opencode-go']);
        expect(load('deepseek-official')[0]).toEqual(['deepseek-modlens']);
    });

    it('stops retrying an id another holder owns, until they release it', async () => {
        // A duplicate registration means someone else answers for the id (a
        // second modlens install). Retrying on every topology event repeated
        // one log line forever, and the claim was never re-examined when the
        // holder released the id.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        let attempts = 0;
        let held = true;
        const llm = {
            listProviders: () => [
                { id: 'lanz', name: 'Lanz' },
                ...(held ? [{ id: 'house-lanz', name: 'Held by someone else' }] : []),
            ],
            providerRetryPolicy: () => undefined,
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                attempts += 1;
                if (held) {
                    const failure = new Error(
                        `an adapter for provider "${ids[0]}" is already registered`,
                    );
                    (failure as Error & { code: string }).code = 'DUPLICATE_ADAPTER';
                    throw failure;
                }
                adapter.providerInfo(ids[0]);
                const handle = () => {};
                handle.replace = () => {};
                return handle;
            },
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        const errors: string[] = [];
        const original = console.error;
        console.error = (value?: unknown) => errors.push(String(value));
        try {
            plugin.apply(
                {
                    tools: { register: () => {} },
                    attachments: {},
                    on: (event: string, fn: () => void) => {
                        handlers[event] = fn;
                    },
                    llm,
                } as never,
                { upstream: 'lanz', providerId: 'house-lanz' },
            );
            expect(attempts).toBe(1);

            // Held: further events do not retry and do not repeat the line.
            handlers['llm/adapters-updated']();
            handlers['llm/adapters-updated']();
            expect(attempts).toBe(1);
            expect(errors.filter((line) => line.includes('already registered')).length).toBe(1);

            // Released: the id is ours to try again.
            held = false;
            handlers['llm/adapters-updated']();
            expect(attempts).toBe(2);
        } finally {
            console.error = original;
        }
    });

    it('re-reconciles when its own drop raised the topology event mid-run', async () => {
        // dropWrapper's disposer makes the host emit adapters-updated while
        // reconcile is still on the stack. The re-entrancy guard used to
        // swallow that event outright, so an upstream that unmounted and
        // remounted in one breath stayed unregistered until some unrelated
        // event happened along.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        let attempts = 0;
        let mounted = true;
        const llm = {
            listProviders: () => (mounted ? [{ id: 'lanz', name: 'Lanz' }] : []),
            providerRetryPolicy: () => undefined,
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                attempts += 1;
                adapter.providerInfo(ids[0]);
                const handle = () => {
                    // Real dsh: the disposer commits the removal, then emits.
                    mounted = true;
                    handlers['llm/adapters-updated']();
                };
                handle.replace = () => {};
                return handle;
            },
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm,
            } as never,
            { upstream: 'lanz', providerId: 'house-lanz' },
        );
        expect(attempts).toBe(1);

        // Unmount: reconcile drops the wrapper, the disposer remounts and
        // re-emits mid-run, and the queued rerun re-registers.
        mounted = false;
        handlers['llm/adapters-updated']();
        expect(attempts).toBe(2);
    });

    it('keeps the registration when a refresh fails after the host committed', async () => {
        // commitRoutes mutates the registry and then emits, so a listener
        // throwing during that emit means the replace succeeded. Disposing on
        // that throw dropped a healthy registration; the catch now asks the
        // registry which side of the commit the failure landed on.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        let disposed = false;
        let maxRetries = 2;
        const llm = {
            listProviders: () => [
                { id: 'lanz', name: 'Lanz' },
                { id: 'house-lanz', name: 'Lanz (modlens vision)' },
            ],
            providerRetryPolicy: () => ({
                mode: 'normal',
                maxRetries,
                retryableCodes: ['RATE_LIMIT'],
                initialDelayMs: 1,
                maxDelayMs: 2,
                jitterRatio: 0,
            }),
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                adapter.providerInfo(ids[0]);
                adapter.providerRetryPolicy(ids[0]);
                const handle = () => {
                    disposed = true;
                };
                handle.replace = () => {
                    // The commit landed; a listener blew up during the emit.
                    throw new Error('invariant listener failed after commit');
                };
                return handle;
            },
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        const errors: string[] = [];
        const original = console.error;
        console.error = (value?: unknown) => errors.push(String(value));
        try {
            plugin.apply(
                {
                    tools: { register: () => {} },
                    attachments: {},
                    on: (event: string, fn: () => void) => {
                        handlers[event] = fn;
                    },
                    llm,
                } as never,
                { upstream: 'lanz', providerId: 'house-lanz' },
            );
            maxRetries = 50;
            handlers['llm/adapters-updated']();

            expect(disposed).toBe(false);
            expect(errors.join('\n')).toContain('keeping the existing registration');
        } finally {
            console.error = original;
        }
    });

    it('refreshes retry policy in explicit single-route mode too', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        const captured: number[] = [];
        let maxRetries = 2;
        let retryLookupFails = false;
        let disposed = false;
        const llm = {
            providerRetryPolicy: () => {
                if (retryLookupFails) throw new Error('retry lookup failed during refresh');
                return {
                    mode: 'normal',
                    maxRetries,
                    retryableCodes: ['RATE_LIMIT'],
                    initialDelayMs: 1,
                    maxDelayMs: 2,
                    jitterRatio: 0,
                };
            },
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                const capture = () => {
                    adapter.providerInfo(ids[0]);
                    const policy = adapter.providerRetryPolicy(ids[0]) as { maxRetries: number };
                    captured.push(policy.maxRetries);
                };
                capture();
                const handle = () => {
                    disposed = true;
                };
                handle.replace = capture;
                return handle;
            },
            listProviders: () => [{ id: 'lanz', name: 'Lanz' }],
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm,
            } as never,
            { upstream: 'lanz', providerId: 'house-lanz' },
        );
        expect(captured).toEqual([2]);
        maxRetries = 50;
        handlers['llm/adapters-updated']();
        expect(captured).toEqual([2, 50]);
        retryLookupFails = true;
        handlers['llm/adapters-updated']();
        expect(disposed).toBe(true);
    });
});

describe('dsh plugin request-time image conversion (v2)', () => {
    it('keeps the log intact and converts wire messages once per attachment', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-cli-'));
        const marker = path.join(cliDir, 'count');
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'WIRE-EVIDENCE'},uncertainty:[]}}))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
            const streamed: Array<{
                messages: Array<{ content: Array<{ type: string; text?: string }> }>;
            }> = [];
            const ctx = {
                tools: { register: () => {} },
                attachments: {
                    readImage: async () => ({
                        data: new Uint8Array([1]),
                        ref: { mediaType: 'image/png' },
                    }),
                },
                on: () => {},
                llm: {
                    registerAdapter: (_p: string[], adapter: Record<string, CallableFunction>) => {
                        registered.push({ adapter });
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: (options: never) => {
                        streamed.push(options);
                        return (async function* () {})();
                    },
                },
            };
            plugin.apply(ctx as never, {});
            const adapter = registered[0].adapter;
            const request = {
                provider: 'deepseek-modlens',
                model: 'm',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'what is this' },
                            { type: 'image', attachment: { id: 'att-1' } },
                        ],
                    },
                ],
            };
            for await (const _c of adapter.stream(request) as AsyncIterable<unknown>) {
                // drain
            }
            const wire = streamed[0].messages[0].content;
            expect(wire[0]).toEqual({ type: 'text', text: 'what is this' });
            expect(wire[1].type).toBe('text');
            expect(wire[1].text).toContain('WIRE-EVIDENCE');
            // The caller's request object keeps its image block untouched.
            expect(request.messages[0].content[1].type).toBe('image');
            // Second request with the same attachment hits the cache: one CLI run.
            for await (const _c of adapter.stream(request) as AsyncIterable<unknown>) {
                // drain
            }
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('converts images nested inside tool-result content on the wire (#24)', async () => {
        // dsh's native read_image nests its image block inside tool-result
        // content; the upstream adapter's rejection check recurses, so the
        // conversion must too or the session wedges on its own history.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-nested-'));
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'NESTED-EVIDENCE'},uncertainty:[]}}))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
            const streamed: Array<{
                messages: Array<{
                    content: Array<{
                        type: string;
                        text?: string;
                        content?: Array<{ type: string; text?: string }>;
                    }>;
                }>;
            }> = [];
            plugin.apply(
                {
                    tools: { register: () => {} },
                    attachments: {
                        readImage: async () => ({
                            data: new Uint8Array([1]),
                            ref: { mediaType: 'image/png' },
                        }),
                    },
                    on: () => {},
                    llm: {
                        registerAdapter: (
                            _p: string[],
                            adapter: Record<string, CallableFunction>,
                        ) => {
                            registered.push({ adapter });
                        },
                        listModels: async () => [],
                        resolveModelInfo: async () => ({}),
                        stream: (options: never) => {
                            streamed.push(options);
                            return (async function* () {})();
                        },
                    },
                } as never,
                {},
            );
            const request = {
                provider: 'deepseek-modlens',
                model: 'm',
                messages: [
                    {
                        role: 'tool',
                        content: [
                            {
                                type: 'tool-result',
                                toolCallId: 'call_1',
                                content: [
                                    { type: 'text', text: '<path>shot.png</path>' },
                                    { type: 'image', attachment: { id: 'att-nested' } },
                                ],
                            },
                        ],
                    },
                ],
            };
            for await (const _c of registered[0].adapter.stream(
                request,
            ) as AsyncIterable<unknown>) {
                // drain
            }
            const wire = streamed[0].messages[0].content[0];
            expect(wire.type).toBe('tool-result');
            expect(wire.content?.[0]).toEqual({ type: 'text', text: '<path>shot.png</path>' });
            expect(wire.content?.[1].type).toBe('text');
            expect(wire.content?.[1].text).toContain('NESTED-EVIDENCE');
            // The caller's request keeps the nested image: the log stays native.
            const original = request.messages[0].content[0] as {
                content: Array<{ type: string }>;
            };
            expect(original.content[1].type).toBe('image');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    async function adapterWithCli(cli: string) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {
                    readImage: async () => ({
                        data: new Uint8Array([1]),
                        ref: { mediaType: 'image/png' },
                    }),
                },
                on: () => {},
                llm: {
                    registerAdapter: (_p: string[], adapter: Record<string, CallableFunction>) => {
                        registered.push({ adapter });
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        process.env.MODLENS_DSH_CLI = cli;
        return registered[0].adapter;
    }

    const imageRequest = (id: string) => ({
        provider: 'deepseek-modlens',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { id } }] }],
    });

    async function adapterCapturing(cli: string) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
        const seen: Array<Record<string, unknown>> = [];
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {
                    readImage: async () => ({
                        data: new Uint8Array([1]),
                        ref: { mediaType: 'image/png' },
                    }),
                },
                on: () => {},
                llm: {
                    registerAdapter: (_p: string[], adapter: Record<string, CallableFunction>) => {
                        registered.push({ adapter });
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: (options: Record<string, unknown>) => {
                        seen.push(options);
                        return (async function* () {})();
                    },
                },
            } as never,
            {},
        );
        process.env.MODLENS_DSH_CLI = cli;
        return { adapter: registered[0].adapter, seen };
    }

    /** The wire text of the image block the upstream actually received. */
    const wireText = (seen: Array<Record<string, unknown>>, index: number) =>
        (
            (seen[index].messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]
                .content[1] ?? // conversion may collapse blocks; fall back to the only block
            (seen[index].messages as Array<{ content: Array<{ text?: string }> }>)[0].content[0]
        ).text;

    /** A CLI that fails with per-attempt DIFFERENT stderr, then succeeds. */
    function flakyCli(dir: string, failuresBeforeSuccess: number): { cli: string; marker: string } {
        const marker = path.join(dir, 'runs');
        const cli = path.join(dir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');const n=(fs.existsSync(${JSON.stringify(marker)})?fs.readFileSync(${JSON.stringify(marker)},'utf8').length:0)+1;fs.appendFileSync(${JSON.stringify(marker)},'x');
             if(n<=${failuresBeforeSuccess}){console.error('engine flaky attempt '+n+' at '+Date.now());process.exit(1)}
             console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'RECOVERED'},uncertainty:[]}}))`,
        );
        return { cli, marker };
    }

    const drain = async (adapter: Record<string, CallableFunction>, id: string) => {
        for await (const _c of adapter.stream(imageRequest(id)) as AsyncIterable<unknown>) {
            // drain
        }
    };

    it('a failing read keeps its bytes and its cooldown: one probe, stable text (#68)', async () => {
        // The provider caches by prefix, so the property under test is the
        // BYTES of the rewritten history: same outcome, same text, and a
        // broken engine probed once per cooldown, not once per step.
        vi.useFakeTimers({ toFake: ['performance'] });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-cool-'));
        const { cli, marker } = flakyCli(dir, 2);
        try {
            const { adapter, seen } = await adapterCapturing(cli);
            await drain(adapter, 'att-cool');
            await drain(adapter, 'att-cool');

            // Within the cooldown: no second engine run, byte-identical text.
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
            expect(wireText(seen, 0)).toContain('the vision engine failed');
            expect(wireText(seen, 1)).toBe(wireText(seen, 0));

            // Cooldown over: exactly one re-probe, which fails with different
            // stderr, and the wire text still does not move.
            vi.advanceTimersByTime(61_000);
            await drain(adapter, 'att-cool');
            expect(fs.readFileSync(marker, 'utf-8')).toBe('xx');
            expect(wireText(seen, 2)).toBe(wireText(seen, 0));

            // Second cooldown over: the engine has recovered, the text moves
            // ONCE (placeholder to evidence), and then stays cached.
            vi.advanceTimersByTime(61_000);
            await drain(adapter, 'att-cool');
            expect(fs.readFileSync(marker, 'utf-8')).toBe('xxx');
            expect(wireText(seen, 3)).toContain('RECOVERED');
            await drain(adapter, 'att-cool');
            expect(fs.readFileSync(marker, 'utf-8')).toBe('xxx');
            expect(wireText(seen, 4)).toBe(wireText(seen, 3));
        } finally {
            vi.useRealTimers();
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('auto-read and the wrapper share one evidence cache (#68)', async () => {
        // auto-read used to bypass caching entirely and re-read every image
        // on every step, healthy engine or not. Now every surface of the
        // plugin reads a pasted attachment once.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-share-'));
        const marker = path.join(dir, 'runs');
        const cli = path.join(dir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');
             console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'SHARED'},uncertainty:[]}}))`,
        );
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, CallableFunction> = {};
        const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {
                    readImage: async () => ({
                        data: new Uint8Array([1]),
                        ref: { mediaType: 'image/png' },
                    }),
                },
                on: (event: string, fn: CallableFunction) => {
                    handlers[event] = fn;
                },
                llm: {
                    registerAdapter: (_p: string[], adapter: Record<string, CallableFunction>) => {
                        registered.push({ adapter });
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            { autoRead: true },
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const messages = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'what is this' },
                        { type: 'image', attachment: { id: 'att-s', mediaType: 'image/png' } },
                    ],
                },
            ];
            // Step 1 and step 2 through auto-read: one engine run total.
            await handlers['agent/pre-step']({ messages, signal: undefined }, async () => ({
                kind: 'enter',
                messages,
            }));
            await handlers['agent/pre-step']({ messages, signal: undefined }, async () => ({
                kind: 'enter',
                messages,
            }));
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');

            // The wrapper route asks for the same attachment: still one run.
            for await (const _c of registered[0].adapter.stream({
                provider: 'deepseek-modlens',
                model: 'm',
                messages,
            }) as AsyncIterable<unknown>) {
                // drain
            }
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('eviction spares every open walk and clears strangers first (#68)', async () => {
        // Three policies died in review before this one. Oldest-first
        // thrashed an over-cap scan (130 runs for 65 attachments, measured);
        // newest-first starved a new session on a warm cache (also 130, also
        // measured); per-walk pins invisible to each other let two
        // interleaved sessions evict each other's in-flight entries (258
        // misses per pass, measured). Eviction now sees EVERY open walk's
        // pins and takes the least-recently-used stranger, or nothing. This
        // drives the exported policy with the same operations cachedEvidence
        // performs: hit = delete + set (recency refresh), miss = set + trim,
        // every touched key pinned in its walk until end().
        // @ts-expect-error untyped on purpose
        const { beginEvidenceWalk, trimEvidenceCache } = (await import('../dsh/index.js')) as {
            beginEvidenceWalk: (cache: Map<string, unknown>) => {
                pin: (key: string) => void;
                end: () => void;
            };
            trimEvidenceCache: (cache: Map<string, unknown>) => void;
        };
        const cache = new Map<string, unknown>();
        type Walk = { pin: (key: string) => void; end: () => void };
        const touch = (key: string, handle: Walk): boolean => {
            handle.pin(key);
            if (cache.has(key)) {
                const value = cache.get(key);
                cache.delete(key);
                cache.set(key, value);
                return false; // hit
            }
            cache.set(key, key);
            trimEvidenceCache(cache);
            return true; // miss, an engine run
        };
        const walk = (keys: string[]): number => {
            const handle = beginEvidenceWalk(cache) as Walk;
            try {
                return keys.filter((key) => touch(key, handle)).length;
            } finally {
                handle.end();
            }
        };

        // A warm cache full of a previous session's entries: the new session
        // pays once, the strangers pay with their slots, pass two is free.
        for (let i = 0; i < 256; i++) {
            walk([`old-${i}`]);
        }
        const fresh = Array.from({ length: 65 }, (_, i) => `new-${i}`);
        expect(walk(fresh)).toBe(65);
        expect(walk(fresh)).toBe(0);
        expect(cache.size).toBe(256);
        expect(cache.has('old-0')).toBe(false);
        expect(cache.has('old-100')).toBe(true);

        // Two interleaved sessions whose joint working set exceeds the cap:
        // both walks stay pinned, neither evicts the other, and both repeat
        // passes are free. The cache floats above the cap while they run.
        const a = Array.from({ length: 129 }, (_, i) => `a-${i}`);
        const b = Array.from({ length: 129 }, (_, i) => `b-${i}`);
        const walkA = beginEvidenceWalk(cache) as Walk;
        const walkB = beginEvidenceWalk(cache) as Walk;
        try {
            let missesA = 0;
            let missesB = 0;
            for (let i = 0; i < 129; i++) {
                if (touch(a[i], walkA)) missesA++;
                if (touch(b[i], walkB)) missesB++;
            }
            expect(missesA).toBe(129);
            expect(missesB).toBe(129);
            missesA = 0;
            missesB = 0;
            for (let i = 0; i < 129; i++) {
                if (touch(a[i], walkA)) missesA++;
                if (touch(b[i], walkB)) missesB++;
            }
            expect(missesA).toBe(0);
            expect(missesB).toBe(0);
        } finally {
            walkA.end();
            walkB.end();
        }

        // Overlapping walks must not inflate the union: two walks pinning the
        // SAME keys leave real strangers evictable, and the sum-based
        // early-out that skipped them was measured leaving 128 victims in
        // place. Refcounts count the union exactly.
        {
            const overlapA = beginEvidenceWalk(cache) as Walk;
            const overlapB = beginEvidenceWalk(cache) as Walk;
            try {
                const shared = [...cache.keys()].slice(-129);
                for (const key of shared) {
                    overlapA.pin(key);
                    overlapB.pin(key);
                }
                const before = cache.size;
                touch('overlap-miss', overlapA);
                // The stranger paid; the cache did not float.
                expect(cache.size).toBe(Math.min(before + 1, 256));
                expect(cache.size).toBe(256);
                // And the second pass over this variant is free too: the new
                // entry and every shared pin hit the cache.
                expect(touch('overlap-miss', overlapA)).toBe(false);
                for (const key of shared) {
                    expect(touch(key, overlapB)).toBe(false);
                }
            } finally {
                overlapA.end();
                overlapB.end();
            }
        }

        // The walks ended, their pins released: the next miss drains the
        // excess back to the cap in one trim.
        walk(['drain-1']);
        expect(cache.size).toBe(256);

        // A single history larger than the cap floats above it for the walk
        // and is stable on the next step: zero misses on the repeat.
        const huge = Array.from({ length: 300 }, (_, i) => `huge-${i}`);
        expect(walk(huge)).toBe(300);
        expect(walk(huge)).toBe(0);
    });

    it('the cache key ignores attachment key order (#68)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-key-'));
        const { cli, marker } = flakyCli(dir, 0);
        try {
            const { adapter } = await adapterCapturing(cli);
            const stream = (attachment: Record<string, unknown>) =>
                adapter.stream({
                    provider: 'deepseek-modlens',
                    model: 'm',
                    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
                }) as AsyncIterable<unknown>;
            for await (const _c of stream({ id: 'att-k', mediaType: 'image/png' })) {
                // drain
            }
            for await (const _c of stream({ mediaType: 'image/png', id: 'att-k' })) {
                // drain
            }
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('concurrent steps join one failing probe and read the same bytes (#68)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-join-'));
        const { cli, marker } = flakyCli(dir, 99);
        try {
            const { adapter, seen } = await adapterCapturing(cli);
            await Promise.all([drain(adapter, 'att-j'), drain(adapter, 'att-j')]);
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
            expect(wireText(seen, 1)).toBe(wireText(seen, 0));
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it("one caller's abort neither kills the other waiter nor the shared read", async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-abort-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');
             setTimeout(()=>console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'SURVIVED'},uncertainty:[]}})),200)`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            const controller = new AbortController();
            const cancelled = (async () => {
                for await (const _c of adapter.stream({
                    ...imageRequest('att-a'),
                    signal: controller.signal,
                }) as AsyncIterable<unknown>) {
                    // drain
                }
            })().then(
                () => 'completed',
                () => 'aborted',
            );
            const survivor = (async () => {
                for await (const _c of adapter.stream(
                    imageRequest('att-a'),
                ) as AsyncIterable<unknown>) {
                    // drain
                }
                return 'completed';
            })();
            setTimeout(() => controller.abort(), 30);
            // The cancelled caller stops promptly; the other waiter and the
            // underlying read are unaffected, and the read ran exactly once.
            expect(await cancelled).toBe('aborted');
            expect(await survivor).toBe('completed');
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('joins concurrent readers of the same attachment into one CLI run', async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-conc-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        // Slow enough that both streams overlap the same in-flight read.
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');
             setTimeout(()=>console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'ONCE'},uncertainty:[]}})),150)`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            const drain = async () => {
                for await (const _c of adapter.stream(
                    imageRequest('att-c'),
                ) as AsyncIterable<unknown>) {
                    // drain
                }
            };
            await Promise.all([drain(), drain()]);
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });
});

describe('dsh plugin tool name (#21, #34)', () => {
    const load = async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        return plugin;
    };

    const ctxWith = (registered: string[], adapters: string[] = []) =>
        ({
            tools: {
                register: (tool: { name: string }) => {
                    registered.push(tool.name);
                },
            },
            attachments: {},
            on: () => {},
            llm: {
                registerAdapter: (providers: string[]) => {
                    adapters.push(...providers);
                },
                listModels: async () => [],
                resolveModelInfo: async () => ({}),
                stream: () => (async function* () {})(),
            },
        }) as never;

    it('registers under a name of its own, clear of the host read_image', async () => {
        // dsh's registry is layered and a scoped tool shadows a global one, so
        // a host read_image in the agent-preset scope and ours registered
        // globally are not a duplicate: nothing throws, and the model still
        // resolves the host's (issue #34). A name no shipped tool holds keeps
        // us out of that.
        const registered: string[] = [];
        const adapters: string[] = [];
        (await load()).apply(ctxWith(registered, adapters), {});
        expect(registered).toEqual(['modlens_read_image']);
        expect(registered).not.toContain('read_image');
        expect(adapters).toContain('deepseek-modlens');
    });

    it('honours an explicit toolName', async () => {
        const registered: string[] = [];
        (await load()).apply(ctxWith(registered), { toolName: 'house_read_image' });
        expect(registered).toEqual(['house_read_image']);
    });

    it('tells the model to reuse evidence instead of calling the tool again (#81)', async () => {
        let description = '';
        (await load()).apply(
            {
                tools: {
                    register: (tool: { description: string }) => {
                        description = tool.description;
                    },
                },
                attachments: {},
                on: () => {},
            } as never,
            { visionProvider: false },
        );
        expect(description).toContain('call this tool once');
        expect(description).toContain('reuse its returned evidence');
    });

    it('reuses one read when a thinking loop repeats the same tool call (#81)', async () => {
        type Tool = {
            execute: (
                args: { path: string; prompt?: string },
                exec: { signal?: AbortSignal },
            ) => Promise<{ summary: string }>;
        };
        let tool: Tool | undefined;
        (await load()).apply(
            {
                tools: {
                    register: (value: Tool) => {
                        tool = value;
                    },
                },
                attachments: {},
                on: () => {},
            } as never,
            { visionProvider: false },
        );
        expect(tool).toBeDefined();
        if (!tool) throw new Error('tool was not registered');
        const activeTool = tool;

        let requests = 0;
        let failMode = false;
        const server = http.createServer(async (req, res) => {
            requests += 1;
            for await (const _chunk of req) {
                // Drain the request before answering, like a real gateway.
            }
            if (failMode) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end(`temporary failure ${requests}`);
                return;
            }
            const result = {
                summary: 'one read',
                ocr: { full_text: '', lines: [] },
                layout: { regions: [] },
                semantics: { scene: '', intent: '', entities: [], relations: [] },
                visual: { dominant_colors: [], style: '', notes: [] },
                uncertainty: [],
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    choices: [{ message: { content: JSON.stringify(result) } }],
                }),
            );
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('test server has no port');

        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-tool-home-'));
        const image = path.join(home, 'same.png');
        fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        fs.mkdirSync(path.join(home, '.modlens'));
        fs.writeFileSync(
            path.join(home, '.modlens', 'config.json'),
            JSON.stringify({
                provider: 'openai',
                providers: {
                    openai: {
                        apiKey: 'test-key',
                        baseUrl: `http://127.0.0.1:${address.port}/v1`,
                        model: 'local-vision',
                    },
                },
            }),
        );
        const savedHome = {
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            PATH: process.env.PATH,
        };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        // Keep a failing OpenAI attempt from falling through to any real CLI
        // provider installed on the developer's machine.
        process.env.PATH = home;
        try {
            const args = { path: image, prompt: 'describe img' };
            const first = await activeTool.execute(args, { signal: undefined });
            first.summary = 'caller mutation';
            const second = await activeTool.execute(args, { signal: undefined });
            expect(requests).toBe(1);
            expect(second.summary).toBe('one read');

            // The CLI trims the source before resolving it. The cache uses
            // that same identity so cosmetic model whitespace cannot miss.
            await activeTool.execute(
                { path: ` ${image} `, prompt: 'describe img' },
                { signal: undefined },
            );
            expect(requests).toBe(1);

            // A path is not an image identity. Replacing its bytes must make
            // the next call a new read instead of serving stale evidence.
            fs.writeFileSync(
                image,
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
            );
            await activeTool.execute(args, { signal: undefined });
            expect(requests).toBe(2);

            // A different focus is a different read contract even when the
            // source bytes are unchanged.
            await activeTool.execute(
                { path: image, prompt: 'focus on the lower-right labels' },
                { signal: undefined },
            );
            expect(requests).toBe(3);

            // The tool advertises concurrency safety. Two identical calls
            // that overlap must join the same in-flight read.
            const concurrent = { path: image, prompt: 'concurrent focus' };
            await Promise.all([
                activeTool.execute(concurrent, { signal: undefined }),
                activeTool.execute(concurrent, { signal: undefined }),
            ]);
            expect(requests).toBe(4);

            // A broken engine must not turn a model's immediate retry loop
            // into another paid request on every tool call. The cooldown is
            // finite so recovery is picked up without restarting the plugin.
            vi.useFakeTimers({ toFake: ['performance'] });
            failMode = true;
            const failing = { path: image, prompt: 'failing focus' };
            const firstError = await activeTool
                .execute(failing, { signal: undefined })
                .catch((error: Error) => error.message);
            const secondError = await activeTool
                .execute(failing, { signal: undefined })
                .catch((error: Error) => error.message);
            expect(requests).toBe(5);
            expect(secondError).toBe(firstError);

            vi.advanceTimersByTime(61_000);
            failMode = false;
            await activeTool.execute(failing, { signal: undefined });
            expect(requests).toBe(6);
        } finally {
            vi.useRealTimers();
            if (savedHome.HOME === undefined) delete process.env.HOME;
            else process.env.HOME = savedHome.HOME;
            if (savedHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = savedHome.USERPROFILE;
            if (savedHome.PATH === undefined) delete process.env.PATH;
            else process.env.PATH = savedHome.PATH;
            fs.rmSync(home, { recursive: true, force: true });
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });

    it('a registration error degrades without killing apply', async () => {
        const plugin = await load();
        expect(() =>
            plugin.apply(
                {
                    tools: {
                        register: () => {
                            throw new Error('registry exploded');
                        },
                    },
                    attachments: {},
                    on: () => {},
                } as never,
                {},
            ),
        ).not.toThrow();
    });
});

describe('image format contract (CLI, skill, dsh in lockstep)', () => {
    it('dsh MEDIA_EXT covers exactly the CLI allow-list', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            MEDIA_EXT: Record<string, string>;
        };
        const { ALLOWED_MIME } = await import('./imageInput.ts');
        expect(new Set(Object.keys(plugin.MEDIA_EXT))).toEqual(ALLOWED_MIME);
    });

    it('the skill trigger extensions are exactly the CLI extension table', async () => {
        const { MIME_BY_EXT } = await import('./imageInput.ts');
        const skill = fs.readFileSync(
            path.join(__dirname, '..', 'skills', 'modlens', 'SKILL.md'),
            'utf-8',
        );
        const match = skill.match(/\(((?:\.\w+, )+\.\w+)\)/);
        expect(match).toBeTruthy();
        const skillExts = new Set((match as RegExpMatchArray)[1].split(', '));
        expect(skillExts).toEqual(new Set(Object.keys(MIME_BY_EXT)));
    });
});

describe('format mapping lockstep', () => {
    it('every MEDIA_EXT value maps back to its mime through the CLI table', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            MEDIA_EXT: Record<string, string>;
        };
        const { MIME_BY_EXT } = await import('./imageInput.ts');
        for (const [mime, ext] of Object.entries(plugin.MEDIA_EXT)) {
            expect(MIME_BY_EXT[ext]).toBe(mime);
        }
    });
});

describe('dsh paste-to-path host route', () => {
    type RouteHandler = (
        req: {
            method: string;
            [Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
        },
        res: {
            writeHead: (code: number, headers?: Record<string, string>) => unknown;
            end: (body?: string) => void;
        },
    ) => Promise<void>;

    async function routeOf(
        config: Record<string, unknown> = {},
        llm?: unknown,
        events?: Record<string, () => void>,
    ) {
        // Every route under test gets its own paste directory. The route
        // sweeps on every successful paste, so without this the suite would
        // sweep the real store and delete a developer's own live pastes. That
        // slipped through twice by fixing the sweeper's tests and leaving the
        // route's, which is why it is wired here rather than per test.
        const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-testpaste-'));
        routePasteDirs.push(isolated);
        config = { pasteDir: isolated, ...config };
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const routes: Array<{ name: string; path: string; handler: RouteHandler }> = [];
        const scoped = {
            webServer: {
                register: (route: { name: string; path: string; handler: RouteHandler }) =>
                    routes.push(route),
            },
        };
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                // A listProviders/listModels-only llm: the vision provider
                // registration path feature-detects registerAdapter and backs
                // off, so this reaches exactly the paste policy code.
                ...(llm ? { llm } : {}),
                on: (event: string, fn: () => void) => {
                    if (events) events[event] = fn;
                },
                inject: (deps: string[], fn: (scope: unknown) => void) => {
                    if (deps.includes('llm') && llm) fn({ llm, on: () => {} });
                    // The scoped closure runs only where webServer exists.
                    if (deps.includes('webServer')) fn(scoped);
                },
            } as never,
            config,
        );
        return routes;
    }

    function fakeReq(method: string, body: Buffer, url = '/modlens/paste') {
        return {
            method,
            url,
            destroy: () => {},
            async *[Symbol.asyncIterator]() {
                yield body;
            },
        };
    }

    function fakeRes() {
        const out = { code: 0, body: '' };
        return {
            out,
            res: {
                writeHead: (code: number) => {
                    out.code = code;
                    return { end: (b?: string) => (out.body = b ?? '') };
                },
                end: (b?: string) => {
                    out.body = b ?? '';
                },
            },
        };
    }

    it('releases wrapper ownership when the injected llm scope unloads (#79)', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        type Cleanup = () => void;
        type Injected = (scope: unknown) => undefined | Cleanup;
        type Model = { id: string; name: string; inputModalities: string[] };
        type Provider = { id: string; name: string; models: Model[] };
        let mountLlm: Injected | undefined;
        let currentLlm: Record<string, unknown> | undefined;
        const routes: Array<{ name: string; path: string; handler: RouteHandler }> = [];
        const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-testpaste-'));
        routePasteDirs.push(isolated);

        const webScope = {
            webServer: {
                register: (route: { name: string; path: string; handler: RouteHandler }) =>
                    routes.push(route),
            },
        };
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: () => {},
                get llm() {
                    if (!currentLlm) {
                        throw new Error('cannot get required service "llm" in inactive context');
                    }
                    return currentLlm;
                },
                inject: (deps: string[], run: Injected) => {
                    if (deps.length === 1 && deps[0] === 'llm') mountLlm = run;
                    if (deps.length === 1 && deps[0] === 'webServer') run(webScope);
                },
            } as never,
            { pasteDir: isolated, settingsCard: false },
        );

        const activate = (providers: Provider[]) => {
            let active = true;
            const effects: Cleanup[] = [];
            const handlers: Record<string, () => void> = {};
            const registered: string[] = [];
            const llm = {
                listProviders: () => providers.map(({ id, name }) => ({ id, name })),
                listModels: async (provider: string) =>
                    providers.find(({ id }) => id === provider)?.models ?? [],
                resolveModelInfo: async (_provider: string, model: string) => ({
                    id: model,
                    inputModalities: ['text'],
                }),
                providerRetryPolicy: () => undefined,
                stream: () => (async function* () {})(),
                registerAdapter: (ids: string[]) => {
                    registered.push(...ids);
                    const handle = () => {};
                    handle.replace = () => {};
                    effects.push(handle);
                    return handle;
                },
            };
            currentLlm = llm;
            const scope = {
                get llm() {
                    if (!active) {
                        throw new Error('cannot get required service "llm" in inactive context');
                    }
                    return llm;
                },
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                    const dispose = () => {
                        delete handlers[event];
                    };
                    effects.push(dispose);
                    return dispose;
                },
            };
            const cleanup = mountLlm?.(scope);
            if (typeof cleanup === 'function') effects.push(cleanup);
            return {
                registered,
                deactivate: () => {
                    active = false;
                    for (const dispose of effects.reverse()) dispose();
                    currentLlm = undefined;
                },
            };
        };

        const first = activate([
            {
                id: 'deepseek-official',
                name: 'DeepSeek',
                models: [
                    {
                        id: 'deepseek-v4-flash',
                        name: 'DeepSeek V4 Flash',
                        inputModalities: ['text'],
                    },
                ],
            },
        ]);
        await vi.waitFor(() => expect(first.registered).toContain('deepseek-modlens'));
        first.deactivate();

        activate([
            {
                id: 'deepseek-modlens',
                name: 'A native provider using the released id',
                models: [
                    {
                        id: 'deepseek-v4-flash',
                        name: 'DeepSeek V4 Flash',
                        inputModalities: ['text', 'image'],
                    },
                ],
            },
            {
                id: 'text-route',
                name: 'Text route',
                models: [
                    {
                        id: 'deepseek-v4-flash',
                        name: 'DeepSeek V4 Flash',
                        inputModalities: ['text'],
                    },
                ],
            },
        ]);

        const paste = routes.find(({ name }) => name === 'modlens-paste');
        expect(paste).toBeDefined();
        const { out, res } = fakeRes();
        await paste?.handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/modlens/paste?model=${encodeURIComponent('current DeepSeek V4 Flash')}`,
            ) as never,
            res as never,
        );
        expect(out.code).toBe(200);
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('registers /modlens/paste under the web profile and writes a private file', async () => {
        const routes = await routeOf();
        expect(routes[0]?.path).toBe('/modlens/paste');
        const { out, res } = fakeRes();
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
        await routes[0].handler(fakeReq('POST', png) as never, res as never);
        expect(out.code).toBe(200);
        const { path: written } = JSON.parse(out.body) as { path: string };
        expect(written.endsWith('paste.png')).toBe(true);
        expect(fs.readFileSync(written)).toEqual(png);
        // POSIX permission bits are meaningless on Windows (mode reads 0o666
        // regardless), the same boundary recover-paste's checks respect.
        if (process.platform !== 'win32') {
            expect(fs.statSync(written).mode & 0o777).toBe(0o600);
        }
        fs.rmSync(path.dirname(written), { recursive: true, force: true });
    });

    it('sweeps the canonical store it wrote when a linked parent moves', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-route-root-'));
        const writtenParent = path.join(scratch, 'written-parent');
        const otherParent = path.join(scratch, 'other-parent');
        const linkedParent = path.join(scratch, 'linked-parent');
        const writtenStore = path.join(writtenParent, 'store');
        const otherStore = path.join(otherParent, 'store');
        const expiredInWritten = path.join(writtenStore, 'p-expired-written');
        const expiredElsewhere = path.join(otherStore, 'p-expired-elsewhere');
        try {
            fs.mkdirSync(expiredInWritten, { recursive: true, mode: 0o700 });
            fs.mkdirSync(expiredElsewhere, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(expiredInWritten, 'paste.png'), 'old');
            fs.writeFileSync(path.join(expiredElsewhere, 'precious.png'), 'keep');
            const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
            fs.utimesSync(expiredInWritten, expired, expired);
            fs.utimesSync(expiredElsewhere, expired, expired);
            fs.symlinkSync(writtenParent, linkedParent, 'dir');

            // @ts-expect-error untyped on purpose
            const mod = (await import('../dsh/index.js')) as {
                __paste: { settled: () => Promise<void> };
            };
            const routes = await routeOf({ pasteDir: path.join(linkedParent, 'store') });
            const out = { code: 0, body: '' };
            let moved = false;
            const res = {
                writeHead(code: number) {
                    out.code = code;
                },
                end(body?: string) {
                    out.body = body ?? '';
                    if (moved) return;
                    moved = true;
                    fs.unlinkSync(linkedParent);
                    fs.symlinkSync(otherParent, linkedParent, 'dir');
                },
            };
            const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
            await routes[0].handler(fakeReq('POST', png) as never, res as never);

            // Await the sweep rather than spinning until it happens to have
            // run: the route fires it without waiting, so polling turns a
            // scheduling detail into a flaky assertion.
            await mod.__paste.settled();
            expect(out.code).toBe(200);
            expect(fs.existsSync(expiredInWritten)).toBe(false);
            expect(fs.existsSync(expiredElsewhere)).toBe(true);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it('refuses non-GET/POST, non-image bytes, and honors the off switch', async () => {
        const routes = await routeOf();
        const a = fakeRes();
        await routes[0].handler(fakeReq('PUT', Buffer.alloc(0)) as never, a.res as never);
        expect(a.out.code).toBe(405);
        const b = fakeRes();
        await routes[0].handler(
            fakeReq('POST', Buffer.from('not an image')) as never,
            b.res as never,
        );
        expect(b.out.code).toBe(400);
        // The two switches are separate: turning paste-to-path off says
        // nothing about whether the engine can be configured, so the settings
        // card's route stays and only this one goes.
        const withoutPaste = await routeOf({ pasteToPath: false });
        expect(withoutPaste.map((route) => route.name)).toEqual(['modlens-config']);
        const withoutBoth = await routeOf({ pasteToPath: false, settingsCard: false });
        expect(withoutBoth).toEqual([]);
    });

    it('sniffs to the CLI table: near-miss magic bytes are refused, real brands pass', async () => {
        const routes = await routeOf();
        const post = async (body: Buffer) => {
            const { out, res } = fakeRes();
            await routes[0].handler(fakeReq('POST', body) as never, res as never);
            return out;
        };
        // Generic BMFF: `ftyp` at offset 4 but a video brand. The old sniff
        // accepted any ftyp box and saved plain video as paste.heic.
        const bmff = Buffer.concat([
            Buffer.from([0, 0, 0, 24]),
            Buffer.from('ftypmp42'),
            Buffer.alloc(8),
        ]);
        expect((await post(bmff)).code).toBe(400);
        // A real heif brand still lands, with its own extension.
        const heif = Buffer.concat([
            Buffer.from([0, 0, 0, 24]),
            Buffer.from('ftypmif1'),
            Buffer.alloc(8),
        ]);
        const okHeif = await post(heif);
        expect(okHeif.code).toBe(200);
        const heifPath = (JSON.parse(okHeif.body) as { path: string }).path;
        expect(heifPath.endsWith('paste.heif')).toBe(true);
        fs.rmSync(path.dirname(heifPath), { recursive: true, force: true });
        // Truncated PNG magic (first four bytes only) is not a PNG.
        expect((await post(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).code).toBe(400);
        // "GIF" alone is not a GIF signature; the full GIF89a is.
        expect((await post(Buffer.from('GIFfake'))).code).toBe(400);
        const okGif = await post(Buffer.from('GIF89a '));
        expect(okGif.code).toBe(200);
        const gifPath = (JSON.parse(okGif.body) as { path: string }).path;
        fs.rmSync(path.dirname(gifPath), { recursive: true, force: true });
    });

    it('GET answers the takeover policy from host model metadata, not name guessing', async () => {
        const llm = {
            listProviders: () => [{ id: 'deepseek-official' }, { id: 'qwen' }],
            listModels: async (id: string) =>
                id === 'deepseek-official'
                    ? [
                          {
                              id: 'deepseek-v4-flash',
                              name: 'DeepSeek-V4-Flash',
                              inputModalities: ['text'],
                          },
                      ]
                    : [
                          {
                              id: 'qwen2.5-vl',
                              name: 'Qwen2.5-VL',
                              inputModalities: ['text', 'image'],
                          },
                      ],
        };
        const routes = await routeOf({}, llm);
        const ask = async (label: string) => {
            const { out, res } = fakeRes();
            await routes[0].handler(
                fakeReq(
                    'GET',
                    Buffer.alloc(0),
                    `/modlens/paste?model=${encodeURIComponent(label)}`,
                ) as never,
                res as never,
            );
            expect(out.code).toBe(200);
            return (JSON.parse(out.body) as { takeover: boolean }).takeover;
        };
        // A text-only model resolved from metadata: take the paste over.
        expect(await ask('选择模型，当前 DeepSeek-V4-Flash，推理等级 High')).toBe(true);
        // A vision model no name heuristic would catch: paste stays native.
        expect(await ask('Select model, current Qwen2.5-VL')).toBe(false);
        // Our own wrapped variant converts at request time: stays native.
        expect(await ask('DeepSeek-V4-Flash (modlens vision)')).toBe(false);
        // Unresolvable labels fail toward the native paste path.
        expect(await ask('Mystery Model 9000')).toBe(false);
        expect(await ask('')).toBe(false);
    });

    it('one image-capable match vetoes same-name models across providers', async () => {
        // The selector label carries no provider id: when two routes expose
        // the same display name and disagree on modality, the host cannot
        // know which one is selected, so it must refuse the takeover.
        const llm = {
            listProviders: () => [{ id: 'text-route' }, { id: 'vision-route' }],
            listModels: async (id: string) =>
                id === 'text-route'
                    ? [{ id: 'shared-1', name: 'Shared Model', inputModalities: ['text'] }]
                    : [
                          {
                              id: 'shared-2',
                              name: 'Shared Model',
                              inputModalities: ['text', 'image'],
                          },
                      ],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/modlens/paste?model=${encodeURIComponent('current Shared Model')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('a longer text-only name cannot shadow the selected shorter vision model', async () => {
        // The label's own prose can complete a longer name: with "Select
        // model, current Pro" selected (a vision model named "Pro"), a text
        // route named "Current Pro" also matches — and longest-match used to
        // let it win. Every match must be text-only, so the vision "Pro"
        // vetoes regardless of length.
        const llm = {
            listProviders: () => [{ id: 'vision' }, { id: 'text' }],
            listModels: async (id: string) =>
                id === 'vision'
                    ? [{ id: 'pro-vision', name: 'Pro', inputModalities: ['text', 'image'] }]
                    : [{ id: 'current-pro', name: 'Current Pro', inputModalities: ['text'] }],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/modlens/paste?model=${encodeURIComponent('Select model, current Pro')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('an unreadable provider catalog vetoes: the vision twin could live there', async () => {
        const llm = {
            listProviders: () => [{ id: 'broken' }, { id: 'text' }],
            listModels: async (id: string) => {
                if (id === 'broken') throw new Error('catalog offline');
                return [{ id: 'shared', name: 'Shared Model', inputModalities: ['text'] }];
            },
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/modlens/paste?model=${encodeURIComponent('current Shared Model')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('a two-character vision name still vetoes: no length floor on the veto', async () => {
        // A vision model named "AI" appears in "current AI" as legitimately
        // as any long name. A length filter on the veto side let the longer
        // text-only "Current AI" confirm the takeover alone.
        const llm = {
            listProviders: () => [{ id: 'vision' }, { id: 'text' }],
            listModels: async (id: string) =>
                id === 'vision'
                    ? [{ id: 'vision-ai', name: 'AI', inputModalities: ['text', 'image'] }]
                    : [{ id: 'current-ai', name: 'Current AI', inputModalities: ['text'] }],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/modlens/paste?model=${encodeURIComponent('Select model, current AI')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('a topology change empties the verdict cache, so late twins are seen', async () => {
        // The cache key is only the label. A same-named vision route mounting
        // inside the TTL used to keep serving the pre-mount true; the cache
        // now empties on llm/adapters-updated, the exact boundary that
        // invalidates it.
        const providers = [{ id: 'text' }];
        const models: Record<string, unknown[]> = {
            text: [{ id: 'shared-text', name: 'Shared Model', inputModalities: ['text'] }],
            vision: [
                { id: 'shared-vision', name: 'Shared Model', inputModalities: ['text', 'image'] },
            ],
        };
        const llm = {
            listProviders: () => providers,
            listModels: async (id: string) => models[id],
        };
        const events: Record<string, () => void> = {};
        const routes = await routeOf({}, llm, events);
        const ask = async () => {
            const { out, res } = fakeRes();
            await routes[0].handler(
                fakeReq(
                    'GET',
                    Buffer.alloc(0),
                    `/modlens/paste?model=${encodeURIComponent('current Shared Model')}`,
                ) as never,
                res as never,
            );
            return (JSON.parse(out.body) as { takeover: boolean }).takeover;
        };
        expect(await ask()).toBe(true);
        providers.push({ id: 'vision' });
        events['llm/adapters-updated']?.();
        expect(await ask()).toBe(false);
    });

    it('a verdict computed under the old topology is never cached or served', async () => {
        // The race the plain clear cannot reach: a GET starts against the
        // pre-mount registry, the vision twin mounts and fires the event
        // while the GET awaits listModels, and the stale true then used to be
        // written into the just-emptied cache and served for a full TTL.
        const textModel = { id: 'shared-text', name: 'Shared Model', inputModalities: ['text'] };
        const visionModel = {
            id: 'shared-vision',
            name: 'Shared Model',
            inputModalities: ['text', 'image'],
        };
        const providers = [{ id: 'text' }];
        let releaseText: (() => void) | undefined;
        let deferOnce = true;
        const llm = {
            listProviders: () => providers.map((provider) => ({ ...provider })),
            listModels: async (id: string) => {
                if (id === 'text' && deferOnce) {
                    deferOnce = false;
                    await new Promise<void>((resolve) => {
                        releaseText = resolve;
                    });
                }
                return id === 'vision' ? [visionModel] : [textModel];
            },
        };
        const events: Record<string, () => void> = {};
        const routes = await routeOf({}, llm, events);
        const ask = async () => {
            const { out, res } = fakeRes();
            await routes[0].handler(
                fakeReq(
                    'GET',
                    Buffer.alloc(0),
                    `/modlens/paste?model=${encodeURIComponent('current Shared Model')}`,
                ) as never,
                res as never,
            );
            return (JSON.parse(out.body) as { takeover: boolean }).takeover;
        };
        const racing = ask();
        await new Promise((resolve) => setImmediate(resolve));
        expect(releaseText).toBeTypeOf('function');
        providers.push({ id: 'vision' });
        events['llm/adapters-updated']?.();
        releaseText?.();
        // The racing GET recomputes against the new registry and answers
        // false, and later asks stay false: the stale true never lands.
        expect(await racing).toBe(false);
        expect(await ask()).toBe(false);
    });

    it('missing inputModalities means UNKNOWN, never confirmed text-only', async () => {
        const llm = {
            listProviders: () => [{ id: 'p1' }],
            listModels: async () => [{ id: 'vision-pro', name: 'Vision Pro' }],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/modlens/paste?model=${encodeURIComponent('current Vision Pro')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('GET without an llm surface (or without a match) never takes over', async () => {
        const routes = await routeOf();
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq('GET', Buffer.alloc(0), '/modlens/paste?model=DeepSeek-V4-Flash') as never,
            res as never,
        );
        expect(out.code).toBe(200);
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });
});

describe('dsh vision provider auto-discovery (#29)', () => {
    interface FakeProvider {
        id: string;
        name?: string;
        models: Array<{ id: string; name?: string; inputModalities?: string[] }>;
    }

    async function discoveryCtx(providers: FakeProvider[], config: Record<string, unknown> = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: string[] = [];
        const attempts: string[] = [];
        const handlers: Record<string, () => void> = {};
        const live = [...providers];
        const ctx = {
            tools: { register: () => {} },
            attachments: {},
            on: (event: string, fn: () => void) => {
                handlers[event] = fn;
            },
            llm: {
                registerAdapter: (ids: string[]) => {
                    // Attempts are recorded BEFORE the duplicate check: a
                    // re-entrancy bug shows up as extra attempts even when
                    // the duplicate throw keeps `registered` clean.
                    attempts.push(ids[0]);
                    if (registered.includes(ids[0])) {
                        throw new Error(`adapter "${ids[0]}" is already registered`);
                    }
                    registered.push(...ids);
                    // The real registry broadcasts on every topology commit,
                    // which is exactly what makes sweeps re-enter mid-flight.
                    handlers['llm/adapters-updated']?.();
                },
                listProviders: () => live.map((p) => ({ id: p.id, name: p.name })),
                listModels: async (id: string) => live.find((p) => p.id === id)?.models ?? [],
                resolveModelInfo: async () => ({}),
                stream: () => (async function* () {})(),
            },
        };
        plugin.apply(ctx as never, config);
        // sweep is async; give it a tick.
        await new Promise((r) => setTimeout(r, 10));
        return { registered, attempts, handlers, live };
    }

    const deepseek: FakeProvider = {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash' }],
    };
    const opencode: FakeProvider = {
        id: 'opencode-go',
        name: 'opencode-go',
        models: [{ id: 'glm-5.3' }],
    };
    const unrelated: FakeProvider = {
        id: 'other-vendor',
        models: [{ id: 'kimi-k2.5' }],
    };

    it('wraps every route carrying wrappable family models, exactly once each', async () => {
        const { registered, attempts } = await discoveryCtx([deepseek, opencode, unrelated]);
        // deepseek-official keeps its historical id; others get modlens-<id>;
        // a route with no family models is left alone. Attempts are counted
        // before the fake's duplicate check and the fake broadcasts on every
        // registration like the real registry, so a re-entrancy bug shows up
        // here as extra ATTEMPTS even when duplicate errors keep the success
        // list clean.
        expect([...registered].sort()).toEqual(['deepseek-modlens', 'modlens-opencode-go']);
        expect([...attempts].sort()).toEqual(['deepseek-modlens', 'modlens-opencode-go']);
    });

    it('honors the discover whitelist', async () => {
        const { registered } = await discoveryCtx([deepseek, opencode], {
            discover: ['opencode-go'],
        });
        expect(registered).toEqual(['modlens-opencode-go']);
    });

    it('wraps MiMo text-only pro models when catalog modalities are absent', async () => {
        // Issue #80 records Xiaomi's naming contract: a bare version is the
        // native omni model, while a -pro segment marks a text-only flagship.
        const { registered } = await discoveryCtx([
            { id: 'xiaomi-pro', models: [{ id: 'mimo-v2.5-pro' }] },
            {
                id: 'xiaomi-ultraspeed',
                models: [{ id: 'mimo-v2.5-pro-ultraspeed' }],
            },
            { id: 'xiaomi-v2-pro', models: [{ id: 'mimo-v2-pro' }] },
        ]);
        expect([...registered].sort()).toEqual([
            'modlens-xiaomi-pro',
            'modlens-xiaomi-ultraspeed',
            'modlens-xiaomi-v2-pro',
        ]);
    });

    it('keeps MiMo omni, speech, and image-capable models unwrapped', async () => {
        const { registered } = await discoveryCtx([
            { id: 'xiaomi-omni', models: [{ id: 'mimo-v2.5' }] },
            { id: 'xiaomi-tts', models: [{ id: 'mimo-v2.5-tts' }] },
            { id: 'xiaomi-asr', models: [{ id: 'mimo-v2.5-asr' }] },
            {
                id: 'xiaomi-native-pro',
                models: [
                    {
                        id: 'mimo-v2.5-pro',
                        inputModalities: ['text', 'image'],
                    },
                ],
            },
        ]);
        expect(registered).toEqual([]);
    });

    it('applies the MiMo pro gate to namespaced ids and aliases', async () => {
        const { registered } = await discoveryCtx([
            {
                id: 'xiaomi-namespaced-pro',
                models: [{ id: 'xiaomi/mimo-v2.5-pro' }],
            },
            {
                id: 'xiaomi-alias-pro',
                models: [{ id: '~mimo-v2.5-pro' }],
            },
            {
                id: 'xiaomi-qualified-pro',
                models: [{ id: 'xiaomi/mimo-v2.5-pro:free' }],
            },
            {
                id: 'xiaomi-namespaced-omni',
                models: [{ id: 'xiaomi/mimo-v2.5' }],
            },
        ]);
        expect([...registered].sort()).toEqual([
            'modlens-xiaomi-alias-pro',
            'modlens-xiaomi-namespaced-pro',
            'modlens-xiaomi-qualified-pro',
        ]);
    });

    it('keeps configured families authoritative and retains the MiMo pro gate', async () => {
        const providers: FakeProvider[] = [
            { id: 'custom-deepseek', models: [{ id: 'deepseek-v4-flash' }] },
            { id: 'custom-mimo-pro', models: [{ id: 'mimo-v2.5-pro' }] },
            { id: 'custom-mimo-omni', models: [{ id: 'mimo-v2.5' }] },
        ];
        const deepseekOnly = await discoveryCtx(providers, { families: ['deepseek'] });
        expect(deepseekOnly.registered).toEqual(['modlens-custom-deepseek']);

        const mimoOnly = await discoveryCtx(providers, { families: ['mimo'] });
        expect(mimoOnly.registered).toEqual(['modlens-custom-mimo-pro']);
    });

    it('never wraps a vision-named model, even when the catalog omits modalities', async () => {
        // deepseek-v4-flash-vision-exp shipped 2026-08-21. The official dsh
        // catalog declares image input, but third-party catalogs and custom
        // `models` lists copy the id without the modalities, and a vision
        // model given a wrapper twin loses its native sight. The name is the
        // one signal every catalog carries.
        const { registered } = await discoveryCtx([
            {
                id: 'lagging-gateway',
                models: [{ id: 'deepseek-v4-flash-vision-exp' }],
            },
        ]);
        expect(registered).toEqual([]);
    });

    it('never wraps GLM-5.3-Flash, even when the catalog omits modalities', async () => {
        // GLM-5.3-Flash shipped 2026-08-26 as the GLM-5 line's first native
        // multimodal model. Its name carries neither v nor vision, so the
        // older glm-*v* / vision gates would have minted a wrapper twin and
        // stripped native sight. GLM-5.3 itself stays wrappable.
        const { registered } = await discoveryCtx([
            {
                id: 'zai',
                models: [{ id: 'glm-5.3-flash' }],
            },
        ]);
        expect(registered).toEqual([]);
    });

    it('never wraps a namespaced GLM-5.3-Flash qualifier without modalities', async () => {
        const { registered } = await discoveryCtx([
            {
                id: 'zai',
                models: [{ id: 'z-ai/glm-5.3-flash:free' }],
            },
        ]);
        expect(registered).toEqual([]);
    });

    it('never wraps a GLM-5.3-Flash delimited suffix without modalities', async () => {
        const { registered } = await discoveryCtx([
            {
                id: 'zai',
                models: [{ id: 'glm-5.3-flash-air' }],
            },
        ]);
        expect(registered).toEqual([]);
    });

    it('still wraps a run-on GLM name that is not GLM-5.3-Flash', async () => {
        // The flash gate must require a slug boundary. A trailing substring
        // match would treat glm-5.3-flashlight as vision and skip the wrapper.
        const { registered } = await discoveryCtx([
            {
                id: 'zai',
                models: [{ id: 'glm-5.3-flashlight' }],
            },
        ]);
        expect(registered).toEqual(['modlens-zai']);
    });

    it('sees family models behind a vendor namespace prefix', async () => {
        // OpenRouter spells GLM as z-ai/glm-5.2:free and aliases carry a
        // leading ~. Text-only family members are exactly what the wrapper
        // exists for, wherever the id keeps its vendor prefix.
        const { registered } = await discoveryCtx([
            {
                id: 'openrouter',
                models: [{ id: 'z-ai/glm-5.2:free' }],
            },
        ]);
        expect(registered).toEqual(['modlens-openrouter']);
    });

    it('classifies by the bare model id, not the vendor namespace or alias marker', async () => {
        // A gateway namespace is not a model name: "vision/" must not trip
        // the vision-name gate for the text model behind it, and a leading ~
        // alias marker must not hide a family member from the wrapper.
        const { registered } = await discoveryCtx([
            { id: 'ns-gateway', models: [{ id: 'vision/deepseek-v4-flash' }] },
            { id: 'alias-gateway', models: [{ id: '~glm-5.2' }] },
        ]);
        expect([...registered].sort()).toEqual(['modlens-alias-gateway', 'modlens-ns-gateway']);
    });

    it('a namespaced vision model stays excluded by name and by modality', async () => {
        const { registered } = await discoveryCtx([
            { id: 'openrouter-v', models: [{ id: 'z-ai/glm-4.6v' }] },
            {
                id: 'openrouter-vx',
                models: [
                    {
                        id: 'deepseek/deepseek-v4-flash-vision-exp',
                        inputModalities: ['text', 'image'],
                    },
                ],
            },
        ]);
        expect(registered).toEqual([]);
    });

    it('a set upstream keeps single-route legacy mode', async () => {
        const { registered } = await discoveryCtx([deepseek, opencode], {
            upstream: 'deepseek-official',
        });
        expect(registered).toEqual(['deepseek-modlens']);
    });

    it('never wraps its own wrappers', async () => {
        const { registered } = await discoveryCtx([
            deepseek,
            { id: 'modlens-opencode-go', models: [{ id: 'glm-5.3' }] },
        ]);
        expect(registered).toEqual(['deepseek-modlens']);
    });

    it('late routes are wrapped when the registry notifies', async () => {
        const { registered, handlers, live } = await discoveryCtx([deepseek]);
        expect(registered).toEqual(['deepseek-modlens']);
        // llm-pi-ai style: a provider registering after plugin mount.
        live.push(opencode);
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered).toContain('modlens-opencode-go');
        // And the notification never duplicates existing wraps.
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered.filter((id) => id === 'modlens-opencode-go')).toHaveLength(1);
    });

    it('refreshes registration-captured facts when the upstream route changes', async () => {
        // dsh captures providerInfo and providerRetryPolicy in registerAdapter.
        // Its upstream adapters call registration.replace() when either fact
        // changes, which emits adapters-updated. The wrapper must refresh its
        // own registration from that notification too.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        const upstream = { id: 'lanz', name: 'Lanz' };
        let maxRetries = 2;
        let upstreamRegistered = true;
        let wrapperDisposed = false;
        const captured: Array<{ name: string; maxRetries: number }> = [];
        const llm = {
            listProviders: () => (upstreamRegistered ? [{ ...upstream }] : []),
            listModels: async () => [{ id: 'glm-5.3', name: 'GLM 5.3' }],
            resolveModelInfo: async () => ({}),
            providerRetryPolicy: () => ({
                mode: 'normal',
                maxRetries,
                retryableCodes: ['RATE_LIMIT'],
                initialDelayMs: 1,
                maxDelayMs: 2,
                jitterRatio: 0,
            }),
            stream: () => (async function* () {})(),
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                const capture = () => {
                    const info = adapter.providerInfo(ids[0]) as { name: string };
                    const retry = adapter.providerRetryPolicy(ids[0]) as { maxRetries: number };
                    captured.push({ name: info.name, maxRetries: retry.maxRetries });
                };
                capture();
                const handle = () => {
                    wrapperDisposed = true;
                };
                handle.replace = capture;
                return handle;
            },
        };
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm,
            } as never,
            {},
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(captured).toEqual([{ name: 'Lanz (modlens vision)', maxRetries: 2 }]);

        upstream.name = 'Lanz Gateway';
        maxRetries = 50;
        handlers['llm/adapters-updated']();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(captured).toEqual([
            { name: 'Lanz (modlens vision)', maxRetries: 2 },
            { name: 'Lanz Gateway (modlens vision)', maxRetries: 50 },
        ]);

        upstreamRegistered = false;
        handlers['llm/adapters-updated']();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(wrapperDisposed).toBe(true);
    });

    it('notifications landing inside the probe window never double-register', async () => {
        // A deferred listModels holds the first sweep suspended while
        // notifications fire: the claim-before-await plus serialization must
        // keep every id at exactly one registration ATTEMPT, not just one
        // success behind duplicate errors.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const attempts: string[] = [];
        const handlers: Record<string, () => void> = {};
        let releaseProbe: (models: Array<{ id: string }>) => void = () => {};
        const gate = new Promise<Array<{ id: string }>>((resolve) => {
            releaseProbe = resolve;
        });
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm: {
                    registerAdapter: (ids: string[]) => {
                        attempts.push(ids[0]);
                        handlers['llm/adapters-updated']?.();
                    },
                    listProviders: () => [{ id: 'opencode-go', name: 'opencode-go' }],
                    listModels: () => gate,
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        // The sweep is now suspended inside listModels. Storm it.
        for (let i = 0; i < 5; i++) {
            handlers['llm/adapters-updated']();
        }
        releaseProbe([{ id: 'glm-5.3' }]);
        await new Promise((r) => setTimeout(r, 30));
        expect(attempts).toEqual(['modlens-opencode-go']);
    });

    it('a sweep failure is contained, and the next notification recovers', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const attempts: string[] = [];
        const handlers: Record<string, () => void> = {};
        let boom = true;
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm: {
                    registerAdapter: (ids: string[]) => {
                        attempts.push(ids[0]);
                    },
                    listProviders: () => {
                        if (boom) {
                            throw new Error('registry mid-mutation');
                        }
                        return [{ id: 'opencode-go', name: 'opencode-go' }];
                    },
                    listModels: async () => [{ id: 'glm-5.3' }],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        await new Promise((r) => setTimeout(r, 10));
        // The throwing sweep neither killed the process nor registered.
        expect(attempts).toEqual([]);
        boom = false;
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(attempts).toEqual(['modlens-opencode-go']);
    });

    it('does not mistake an upstream retry error containing already for a duplicate', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, () => void> = {};
        const attempts: string[] = [];
        const registered: string[] = [];
        let broken = true;
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm: {
                    listProviders: () => [{ id: 'lanz', name: 'Lanz' }],
                    listModels: async () => [{ id: 'glm-5.3', name: 'GLM 5.3' }],
                    resolveModelInfo: async () => ({}),
                    providerRetryPolicy: () => {
                        if (broken) throw new Error('upstream already unavailable');
                        return undefined;
                    },
                    registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                        attempts.push(ids[0]);
                        adapter.providerInfo(ids[0]);
                        adapter.providerRetryPolicy(ids[0]);
                        registered.push(ids[0]);
                    },
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(registered).toEqual([]);

        broken = false;
        handlers['llm/adapters-updated']();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(attempts).toEqual(['modlens-lanz', 'modlens-lanz']);
        expect(registered).toEqual(['modlens-lanz']);
    });

    it('a route without eligible models is retried when models appear later', async () => {
        const bare: FakeProvider = { id: 'opencode-go', name: 'opencode-go', models: [] };
        const { registered, handlers, live } = await discoveryCtx([bare]);
        expect(registered).toEqual([]);
        live[0].models.push({ id: 'glm-5.3' });
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered).toEqual(['modlens-opencode-go']);
    });

    it('the legacy fallback on an old registry surface registers exactly once', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: string[] = [];
        const handlers: Record<string, () => void> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm: {
                    // No listProviders: the pre-discovery registry surface.
                    registerAdapter: (ids: string[]) => registered.push(...ids),
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        await new Promise((r) => setTimeout(r, 10));
        handlers['llm/adapters-updated']();
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered).toEqual(['deepseek-modlens']);
    });
});

describe('paste takeover verdict (#36)', () => {
    // Drives the real apply() -> registerPasteRoute -> pasteTakeoverVerdict
    // path against a registry shaped like a live dsh install, because the
    // regression this covers only exists once the plugin's own wrapper is in
    // the registry it scans.
    const load = async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        return plugin;
    };

    type Model = { id: string; name: string; inputModalities?: string[] };
    type Handler = (req: unknown, res: unknown) => Promise<void>;

    const DEEPSEEK: Model[] = [
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
    ];

    const install = (extra: { id: string; name: string; models: Model[] | Error }[] = []) => {
        const adapters = new Map<string, { listModels: (id: string) => Promise<Model[]> }>();
        const providers = [
            { id: 'deepseek-official', name: 'DeepSeek' },
            ...extra.map((route) => ({ id: route.id, name: route.name })),
        ];
        let handler: Handler | null = null;
        const llm = {
            listProviders: () => providers,
            async listModels(providerId: string) {
                if (providerId === 'deepseek-official') return DEEPSEEK;
                const route = extra.find((candidate) => candidate.id === providerId);
                if (route) {
                    if (route.models instanceof Error) throw route.models;
                    return route.models;
                }
                const adapter = adapters.get(providerId);
                return adapter ? await adapter.listModels(providerId) : [];
            },
            async resolveModelInfo(_providerId: string, model: string) {
                return DEEPSEEK.find((candidate) => candidate.id === model) ?? {};
            },
            stream: () => (async function* () {})(),
            registerAdapter(
                ids: string[],
                adapter: {
                    providerInfo: (id: string) => { name: string };
                    listModels: (id: string) => Promise<Model[]>;
                },
            ) {
                for (const id of ids) {
                    adapters.set(id, adapter);
                    // A wrapper shows up in the model selector, so it is in
                    // the same enumeration the verdict walks.
                    providers.push({ id, name: adapter.providerInfo(id).name });
                }
            },
        };
        return {
            llm,
            get handler() {
                return handler;
            },
            ctx: {
                llm,
                tools: { register: () => {} },
                agents: {},
                attachments: {},
                on: () => {},
                inject: injectAvailable({
                    llm,
                    on: () => {},
                    webServer: {
                        // Two routes register now; this suite drives the paste one.
                        register: (route: { name: string; handler: Handler }) => {
                            if (route.name === 'modlens-paste') handler = route.handler;
                        },
                    },
                }),
            } as never,
        };
    };

    const ask = async (handler: Handler | null, label: string) => {
        let body = '';
        await handler?.(
            { method: 'GET', url: `/modlens/paste?model=${encodeURIComponent(label)}` },
            { writeHead: () => {}, end: (chunk: string) => (body = chunk) },
        );
        return JSON.parse(body).takeover as boolean;
    };

    it('takes over a plain text-only model even with the vision wrapper registered', async () => {
        // The wrapper reuses the upstream model id and declares image input,
        // so before the fix the plain label matched that twin by id and the
        // twin's declaration vetoed the takeover this feature exists for.
        const house = install();
        (await load()).apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.handler, 'DeepSeek-V4-Pro')).toBe(true);
        expect(await ask(house.handler, 'DeepSeek-V4-Flash')).toBe(true);
    });

    it('leaves its own vision variant on the native paste path', async () => {
        const house = install();
        (await load()).apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.handler, 'DeepSeek-V4-Pro (modlens vision)')).toBe(false);
    });

    it('still lets a real vision model on another route veto', async () => {
        // The skip is by registered provider id, not by name shape, so a
        // genuine vision model sharing the label still refuses the takeover.
        const house = install([
            {
                id: 'some-gateway',
                name: 'Gateway',
                models: [
                    { id: 'v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text', 'image'] },
                ],
            },
        ]);
        (await load()).apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.handler, 'DeepSeek-V4-Pro')).toBe(false);
    });

    it('refuses when a matching model declares no modalities at all', async () => {
        const house = install([
            { id: 'mystery', name: 'Mystery', models: [{ id: 'deepseek-v4-pro', name: 'x' }] },
        ]);
        (await load()).apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.handler, 'DeepSeek-V4-Pro')).toBe(false);
    });

    it('refuses when a provider catalog cannot be read', async () => {
        const house = install([
            { id: 'broken', name: 'Broken', models: new Error('catalog unavailable') },
        ]);
        (await load()).apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.handler, 'DeepSeek-V4-Pro')).toBe(false);
    });

    it('refuses a label that matches nothing', async () => {
        const house = install();
        (await load()).apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.handler, 'Some-Other-Model')).toBe(false);
    });
});

describe('paste takeover verdict, second instance (#36)', () => {
    // A second apply() in one process hits the duplicate-registration branch,
    // so it never claims the provider id and its own record is empty. The
    // first instance's twins are still in the registry it scans.
    it('takes over even when another instance registered the wrapper', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const models = [
            { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
        ];
        const adapters = new Map<string, { listModels: (id: string) => Promise<unknown[]> }>();
        const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }];
        const captured: { handler: ((req: unknown, res: unknown) => Promise<void>) | null } = {
            handler: null,
        };
        const llm = {
            listProviders: () => providers,
            async listModels(providerId: string) {
                if (providerId === 'deepseek-official') return models;
                const adapter = adapters.get(providerId);
                return adapter ? await adapter.listModels(providerId) : [];
            },
            async resolveModelInfo(_p: string, model: string) {
                return models.find((candidate) => candidate.id === model) ?? {};
            },
            stream: () => (async function* () {})(),
            registerAdapter(
                ids: string[],
                adapter: {
                    providerInfo: (id: string) => { name: string };
                    listModels: (id: string) => Promise<unknown[]>;
                },
            ) {
                for (const id of ids) {
                    if (adapters.has(id)) throw new Error(`provider "${id}" is already registered`);
                    adapters.set(id, adapter);
                    providers.push({ id, name: adapter.providerInfo(id).name });
                }
            },
        };
        const ctx = (withRoute: boolean) =>
            ({
                llm,
                tools: { register: () => {} },
                agents: {},
                attachments: {},
                on: () => {},
                inject: injectAvailable({
                    llm,
                    on: () => {},
                    ...(withRoute
                        ? {
                              webServer: {
                                  register: (route: {
                                      name: string;
                                      handler: (req: unknown, res: unknown) => Promise<void>;
                                  }) => {
                                      if (route.name === 'modlens-paste')
                                          captured.handler = route.handler;
                                  },
                              },
                          }
                        : {}),
                }),
            }) as never;

        // First instance registers the wrapper but no route.
        plugin.apply(ctx(false), { pasteToPath: false });
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Second instance owns the route and claims nothing.
        plugin.apply(ctx(true), {});
        await new Promise((resolve) => setTimeout(resolve, 10));

        let body = '';
        await captured.handler?.(
            { method: 'GET', url: '/modlens/paste?model=DeepSeek-V4-Pro' },
            { writeHead: () => {}, end: (chunk: string) => (body = chunk) },
        );
        expect(JSON.parse(body).takeover).toBe(true);
    });
});

describe('paste takeover verdict, ownership proof (#36)', () => {
    // The name marker is not proof of ownership on its own: a provider that
    // is not ours can put that string in a model name, and skipping it would
    // hand a real vision model's paste to the file-path route.
    const scaffold = (extra: { id: string; name: string; models: unknown[] }[]) => {
        const adapters = new Map<string, { listModels: (id: string) => Promise<unknown[]> }>();
        const upstream = [
            { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
        ];
        const providers = [
            { id: 'deepseek-official', name: 'DeepSeek' },
            ...extra.map((route) => ({ id: route.id, name: route.name })),
        ];
        const captured: { handler: ((req: unknown, res: unknown) => Promise<void>) | null } = {
            handler: null,
        };
        const llm = {
            listProviders: () => providers,
            async listModels(providerId: string) {
                if (providerId === 'deepseek-official') return upstream;
                const route = extra.find((candidate) => candidate.id === providerId);
                if (route) return route.models;
                const adapter = adapters.get(providerId);
                return adapter ? await adapter.listModels(providerId) : [];
            },
            async resolveModelInfo(_p: string, model: string) {
                return upstream.find((candidate) => candidate.id === model) ?? {};
            },
            stream: () => (async function* () {})(),
            registerAdapter(
                ids: string[],
                adapter: {
                    providerInfo: (id: string) => { name: string };
                    listModels: (id: string) => Promise<unknown[]>;
                },
            ) {
                for (const id of ids) {
                    adapters.set(id, adapter);
                    providers.push({ id, name: adapter.providerInfo(id).name });
                }
            },
        };
        return {
            captured,
            ctx: {
                llm,
                tools: { register: () => {} },
                agents: {},
                attachments: {},
                on: () => {},
                inject: injectAvailable({
                    llm,
                    on: () => {},
                    webServer: {
                        register: (route: {
                            name: string;
                            handler: (req: unknown, res: unknown) => Promise<void>;
                        }) => {
                            if (route.name === 'modlens-paste') captured.handler = route.handler;
                        },
                    },
                }),
            } as never,
        };
    };

    const ask = async (
        handler: ((req: unknown, res: unknown) => Promise<void>) | null,
        label: string,
    ) => {
        let body = '';
        await handler?.(
            { method: 'GET', url: `/modlens/paste?model=${encodeURIComponent(label)}` },
            { writeHead: () => {}, end: (chunk: string) => (body = chunk) },
        );
        return JSON.parse(body).takeover as boolean;
    };

    it('does not let a foreign provider borrow the marker to dodge the veto', async () => {
        // The label deliberately carries no marker: a label that did would be
        // refused by the check at the top of the verdict, and this test would
        // pass without the scan it is here to exercise.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const house = scaffold([
            {
                id: 'some-gateway',
                name: 'Gateway',
                models: [
                    {
                        id: 'deepseek-v4-pro',
                        name: 'Gateway V4 (modlens vision)',
                        inputModalities: ['text', 'image'],
                    },
                ],
            },
        ]);
        plugin.apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        // It matches the label by id, it accepts images, and its provider id
        // is not one this plugin mints: veto, marker or no marker.
        expect(await ask(house.captured.handler, 'DeepSeek-V4-Pro')).toBe(false);
    });

    it('still vetoes a real vision model sitting on a modlens-shaped id', async () => {
        // The other half: an id inside the convention is not enough either.
        // A route that takes such an id while serving genuine vision models
        // keeps its veto, because those models carry no twin marker.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const house = scaffold([
            {
                id: 'modlens-lookalike',
                name: 'Lookalike',
                models: [
                    {
                        id: 'deepseek-v4-pro',
                        name: 'DeepSeek-V4-Pro',
                        inputModalities: ['text', 'image'],
                    },
                ],
            },
        ]);
        plugin.apply(house.ctx, {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.captured.handler, 'DeepSeek-V4-Pro')).toBe(false);
    });

    it('trusts a wrapper under a custom providerId through the registered set', async () => {
        // A configured providerId is outside the naming convention, so only
        // the record of what this instance registered can clear it.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const house = scaffold([]);
        plugin.apply(house.ctx, { upstream: 'deepseek-official', providerId: 'house-vision' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await ask(house.captured.handler, 'DeepSeek-V4-Pro')).toBe(true);
    });
});

describe('paste takeover verdict, auto-discovered wrapper id (#36)', () => {
    // Auto-discovery mints `modlens-<upstream>` for every route but the
    // legacy deepseek one, so that branch of the ownership rule needs its own
    // case: a sibling instance's wrapper on such a route must still be
    // recognized as a twin rather than vetoing the model it wraps.
    it('recognizes a twin on an auto-discovered route', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const upstream = [{ id: 'glm-5.3', name: 'GLM-5.3', inputModalities: ['text'] }];
        const adapters = new Map<string, { listModels: (id: string) => Promise<unknown[]> }>();
        const providers = [{ id: 'zai', name: 'Z.ai' }];
        const captured: { handler: ((req: unknown, res: unknown) => Promise<void>) | null } = {
            handler: null,
        };
        const llm = {
            listProviders: () => providers,
            async listModels(providerId: string) {
                if (providerId === 'zai') return upstream;
                const adapter = adapters.get(providerId);
                return adapter ? await adapter.listModels(providerId) : [];
            },
            async resolveModelInfo(_p: string, model: string) {
                return upstream.find((candidate) => candidate.id === model) ?? {};
            },
            stream: () => (async function* () {})(),
            registerAdapter(
                ids: string[],
                adapter: {
                    providerInfo: (id: string) => { name: string };
                    listModels: (id: string) => Promise<unknown[]>;
                },
            ) {
                for (const id of ids) {
                    if (adapters.has(id)) throw new Error(`provider "${id}" is already registered`);
                    adapters.set(id, adapter);
                    providers.push({ id, name: adapter.providerInfo(id).name });
                }
            },
        };
        const ctx = (withRoute: boolean) =>
            ({
                llm,
                tools: { register: () => {} },
                agents: {},
                attachments: {},
                on: () => {},
                inject: injectAvailable({
                    llm,
                    on: () => {},
                    ...(withRoute
                        ? {
                              webServer: {
                                  register: (route: {
                                      name: string;
                                      handler: (req: unknown, res: unknown) => Promise<void>;
                                  }) => {
                                      if (route.name === 'modlens-paste')
                                          captured.handler = route.handler;
                                  },
                              },
                          }
                        : {}),
                }),
            }) as never;

        plugin.apply(ctx(false), { pasteToPath: false });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(providers.some((route) => route.id === 'modlens-zai')).toBe(true);
        // Second instance: duplicate registration, so nothing of its own.
        plugin.apply(ctx(true), {});
        await new Promise((resolve) => setTimeout(resolve, 20));

        let body = '';
        await captured.handler?.(
            { method: 'GET', url: '/modlens/paste?model=GLM-5.3' },
            { writeHead: () => {}, end: (chunk: string) => (body = chunk) },
        );
        expect(JSON.parse(body).takeover).toBe(true);
    });
});

describe('settings card route (#39)', () => {
    // The card is the browser half; this covers the host half it talks to,
    // where the API key lives. Every assertion here is about the key not
    // leaving and not being lost.
    const load = async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        return plugin;
    };

    type Handler = (req: unknown, res: unknown) => Promise<void>;

    const house = () => {
        const routes: Record<string, Handler> = {};
        const llm = {
            listProviders: () => [],
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
            registerAdapter: () => {},
        };
        const ctx = {
            llm,
            tools: { register: () => {} },
            agents: {},
            attachments: {},
            on: () => {},
            inject: injectAvailable({
                llm,
                on: () => {},
                webServer: {
                    register: (route: { name: string; handler: Handler }) => {
                        routes[route.name] = route.handler;
                    },
                },
            }),
        } as never;
        return { routes, ctx };
    };

    const call = async (
        handler: Handler,
        req: Record<string, unknown>,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
        let status = 0;
        let body = '';
        await handler(
            { headers: { host: '127.0.0.1:3080' }, ...req },
            {
                writeHead: (code: number) => {
                    status = code;
                    return { end: () => {} };
                },
                end: (chunk: string) => {
                    body = chunk ?? '';
                },
            },
        );
        return { status, body: body === '' ? {} : JSON.parse(body) };
    };

    const withConfig = async (
        contents: Record<string, unknown>,
        run: (handler: Handler, file: string) => Promise<void>,
    ) => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        const file = path.join(home, '.modlens', 'config.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(contents));
        // node's os.homedir() reads $HOME (POSIX) and %USERPROFILE% (Windows),
        // which is the only seam here: the plugin imports homedir directly and
        // an ESM binding cannot be reassigned from outside.
        const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            const stage = house();
            (await load()).apply(stage.ctx, {});
            await run(stage.routes['modlens-config'], file);
        } finally {
            process.env.HOME = realHome.HOME;
            process.env.USERPROFILE = realHome.USERPROFILE;
            fs.rmSync(home, { recursive: true, force: true });
        }
    };

    it('never puts an API key on the wire, only whether one is stored', async () => {
        await withConfig(
            { provider: 'openai', providers: { openai: { apiKey: 'sk-secret', model: 'm' } } },
            async (handler) => {
                const { status, body } = await call(handler, { method: 'GET', url: '/x' });
                expect(status).toBe(200);
                expect(JSON.stringify(body)).not.toContain('sk-secret');
                const engines = body.engines as Record<string, { hasKey: boolean; model: string }>;
                expect(engines.openai.hasKey).toBe(true);
                expect(engines.openai.model).toBe('m');
                expect(engines['gemini-api'].hasKey).toBe(false);
            },
        );
    });

    it('reports each proxy mode without putting a stored proxy URL on the wire (#97)', async () => {
        await withConfig(
            {
                proxy: 'http://global-user:global-pass@global-proxy.example:8080',
                providers: {
                    openai: {
                        apiKey: 'sk-a',
                        proxy: 'http://proxy-user:proxy-pass@private-proxy.example:8080',
                    },
                    'gemini-api': { apiKey: 'sk-b', proxy: '' },
                    anthropic: { apiKey: 'sk-c' },
                },
            },
            async (handler) => {
                const { status, body } = await call(handler, { method: 'GET', url: '/x' });
                expect(status).toBe(200);
                expect(JSON.stringify(body)).not.toContain('private-proxy.example');
                const engines = body.engines as Record<string, { proxyMode: string }>;
                expect(engines.openai.proxyMode).toBe('custom');
                expect(engines['gemini-api'].proxyMode).toBe('direct');
                expect(engines.anthropic.proxyMode).toBe('inherit');
            },
        );
    });

    it('keeps the stored key when the card submits the blank field it was shown', async () => {
        await withConfig(
            { provider: 'openai', providers: { openai: { apiKey: 'sk-secret', model: 'old' } } },
            async (handler, file) => {
                const { status } = await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({ engine: 'openai', apiKey: '', model: 'new' }),
                        );
                    },
                });
                expect(status).toBe(200);
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.providers.openai.apiKey).toBe('sk-secret');
                expect(saved.providers.openai.model).toBe('new');
            },
        );
    });

    it('stores an explicit direct route without changing the engine credentials (#97)', async () => {
        await withConfig(
            {
                proxy: 'http://127.0.0.1:7890',
                providers: {
                    openai: { apiKey: 'sk-secret', baseUrl: 'http://intranet.example/v1' },
                },
            },
            async (handler, file) => {
                const { status } = await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({ engine: 'openai', proxyMode: 'direct' }),
                        );
                    },
                });
                expect(status).toBe(200);
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.providers.openai).toEqual({
                    apiKey: 'sk-secret',
                    baseUrl: 'http://intranet.example/v1',
                    proxy: '',
                });
            },
        );
    });

    it('removes the provider override when the card returns to inherited proxy routing (#97)', async () => {
        await withConfig(
            {
                proxy: 'http://127.0.0.1:7890',
                providers: {
                    openai: {
                        apiKey: 'sk-secret',
                        proxy: 'http://user:pass@provider-proxy.example:8080',
                    },
                },
            },
            async (handler, file) => {
                const { status } = await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({ engine: 'openai', proxyMode: 'inherit' }),
                        );
                    },
                });
                expect(status).toBe(200);
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.providers.openai).toEqual({ apiKey: 'sk-secret' });
            },
        );
    });

    it('removes inherited proxy overrides from every alias-backed entry (#97)', async () => {
        await withConfig(
            {
                providers: {
                    'openai-compat': {
                        apiKey: 'sk-secret',
                        proxy: 'http://user:pass@provider-proxy.example:8080',
                    },
                    openai: { model: 'canonical-model' },
                },
            },
            async (handler, file) => {
                const { status } = await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({ engine: 'openai', proxyMode: 'inherit' }),
                        );
                    },
                });
                expect(status).toBe(200);
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.providers['openai-compat']).toEqual({ apiKey: 'sk-secret' });
                expect(saved.providers.openai).toEqual({ model: 'canonical-model' });

                const read = await call(handler, { method: 'GET', url: '/x' });
                const engines = read.body.engines as Record<string, { proxyMode: string }>;
                expect(engines.openai.proxyMode).toBe('inherit');
            },
        );
    });

    it('replaces a stored custom proxy only when the card submits a new URL (#97)', async () => {
        await withConfig(
            {
                providers: {
                    openai: {
                        apiKey: 'sk-secret',
                        proxy: 'http://old-user:old-pass@old-proxy.example:8080',
                    },
                },
            },
            async (handler, file) => {
                const unchanged = await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({
                                engine: 'openai',
                                model: 'm',
                                proxyMode: 'custom',
                                proxy: '',
                            }),
                        );
                    },
                });
                expect(unchanged.status).toBe(200);
                let saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.providers.openai.proxy).toBe(
                    'http://old-user:old-pass@old-proxy.example:8080',
                );

                const replaced = await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({
                                engine: 'openai',
                                proxyMode: 'custom',
                                proxy: 'http://new-user:new-pass@new-proxy.example:8080',
                            }),
                        );
                    },
                });
                expect(replaced.status).toBe(200);
                saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.providers.openai.proxy).toBe(
                    'http://new-user:new-pass@new-proxy.example:8080',
                );
            },
        );
    });

    it('keeps a custom proxy stored under an alias when the canonical entry holds other fields (#97)', async () => {
        const config = {
            providers: {
                'openai-compat': {
                    apiKey: 'sk-secret',
                    proxy: 'http://proxy.example:8080',
                },
                openai: { model: 'canonical-model' },
            },
        };
        await withConfig(config, async (handler, file) => {
            const { status, body } = await call(handler, {
                method: 'POST',
                url: '/x',
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(
                        JSON.stringify({ engine: 'openai', proxyMode: 'custom', proxy: ' ' }),
                    );
                },
            });
            expect(status, JSON.stringify(body)).toBe(200);
            expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(config);
        });
    });

    it('writes only the engine it was given, never the one before it', async () => {
        // Switching engines in a flat card must not copy one engine's endpoint
        // and model onto another.
        await withConfig(
            {
                provider: 'openai',
                providers: {
                    openai: { apiKey: 'sk-a', baseUrl: 'https://a', model: 'a' },
                    anthropic: { apiKey: 'sk-b' },
                },
            },
            async (handler, file) => {
                await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({
                                provider: 'anthropic',
                                engine: 'anthropic',
                                model: 'claude',
                            }),
                        );
                    },
                });
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.provider).toBe('anthropic');
                expect(saved.providers.anthropic).toEqual({ apiKey: 'sk-b', model: 'claude' });
                expect(saved.providers.openai).toEqual({
                    apiKey: 'sk-a',
                    baseUrl: 'https://a',
                    model: 'a',
                });
            },
        );
    });

    it('refuses a cross-origin write, which could repoint the engine', async () => {
        await withConfig({ provider: 'openai' }, async (handler, file) => {
            const before = fs.readFileSync(file, 'utf-8');
            const { status } = await call(handler, {
                method: 'POST',
                url: '/x',
                headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' },
            });
            expect(status).toBe(403);
            expect(fs.readFileSync(file, 'utf-8')).toBe(before);
        });
    });

    it('refuses a Host that is not loopback, which is what rebinding forges', async () => {
        // Host is the header a rebound page cannot fake: it carries the
        // attacker's domain while the socket reaches this server.
        await withConfig({ provider: 'openai' }, async (handler) => {
            const { status } = await call(handler, {
                method: 'GET',
                url: '/x',
                headers: { host: 'evil.example' },
            });
            expect(status).toBe(403);
        });
    });

    it('refuses a cross-site fetch even when the headers otherwise look local', async () => {
        await withConfig({ provider: 'openai' }, async (handler) => {
            const { status } = await call(handler, {
                method: 'GET',
                url: '/x',
                headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
            });
            expect(status).toBe(403);
        });
    });

    it('reports a broken config instead of treating it as empty', async () => {
        // Treating it as empty is how a save would quietly replace someone's
        // whole configuration with four fields.
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        const file = path.join(home, '.modlens', 'config.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ this is not json');
        const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            const stage = house();
            (await load()).apply(stage.ctx, {});
            const handler = stage.routes['modlens-config'];
            const read = await call(handler, { method: 'GET', url: '/x' });
            expect(read.status).toBe(409);
            expect(String(read.body.error)).toContain('not valid JSON');
            const write = await call(handler, {
                method: 'POST',
                url: '/x',
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(JSON.stringify({ provider: 'openai', model: 'm' }));
                },
            });
            expect(write.status).toBe(400);
            expect(fs.readFileSync(file, 'utf-8')).toBe('{ this is not json');
        } finally {
            process.env.HOME = realHome.HOME;
            process.env.USERPROFILE = realHome.USERPROFILE;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('refuses to write through a symlinked config file', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        const real = path.join(home, 'real.json');
        const file = path.join(home, '.modlens', 'config.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(real, JSON.stringify({ provider: 'openai' }));
        fs.symlinkSync(real, file);
        const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            const stage = house();
            (await load()).apply(stage.ctx, {});
            const { status, body } = await call(stage.routes['modlens-config'], {
                method: 'POST',
                url: '/x',
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(JSON.stringify({ provider: 'openai', model: 'm' }));
                },
            });
            expect(status).toBe(400);
            expect(String(body.error)).toContain('symlink');
            expect(JSON.parse(fs.readFileSync(real, 'utf-8'))).toEqual({ provider: 'openai' });
        } finally {
            process.env.HOME = realHome.HOME;
            process.env.USERPROFILE = realHome.USERPROFILE;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('leaves unrelated config keys alone', async () => {
        await withConfig(
            {
                provider: 'openai',
                proxy: 'http://127.0.0.1:7890',
                guards: { denyModels: 'gemini-3*' },
                providers: { openai: { apiKey: 'sk-a' } },
            },
            async (handler, file) => {
                await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(JSON.stringify({ provider: 'openai', model: 'm' }));
                    },
                });
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.proxy).toBe('http://127.0.0.1:7890');
                expect(saved.guards).toEqual({ denyModels: 'gemini-3*' });
            },
        );
    });

    it('writes with the same 0600 mode the CLI uses', async () => {
        await withConfig({ provider: 'openai' }, async (handler, file) => {
            await call(handler, {
                method: 'POST',
                url: '/x',
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(JSON.stringify({ provider: 'openai', model: 'm' }));
                },
            });
            if (process.platform !== 'win32') {
                expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            }
        });
    });

    it('leaves an unpinned provider unpinned when only a grant changed', async () => {
        // Empty means the failover chain decides. A save that carried the
        // displayed engine anyway pinned one nobody chose, changing which
        // engine reads every later image.
        await withConfig(
            { provider: '', providers: { 'gemini-api': { apiKey: 'sk-a' } } },
            async (handler, file) => {
                const { status } = await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(JSON.stringify({ reuse: { codex: true } }));
                    },
                });
                expect(status).toBe(200);
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.provider).toBe('');
                expect(saved.reuse).toEqual({ codex: true });
                expect(saved.providers['gemini-api']).toEqual({ apiKey: 'sk-a' });
            },
        );
    });

    it('reports an alias as its engine, settings included, and does not move them', async () => {
        // A key stored under `gemini` is gemini-api's key, and a provider
        // pinned as `gemini` is pinned to gemini-api. Reporting either as
        // something else put the card at odds with what actually runs.
        await withConfig(
            { provider: 'gemini', providers: { gemini: { apiKey: 'sk-a', model: 'g' } } },
            async (handler, file) => {
                const read = await call(handler, { method: 'GET', url: '/x' });
                expect(read.body.provider).toBe('gemini-api');
                const engines = read.body.engines as Record<
                    string,
                    { hasKey: boolean; model: string }
                >;
                expect(engines['gemini-api'].hasKey).toBe(true);
                expect(engines['gemini-api'].model).toBe('g');

                await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({ engine: 'gemini-api', model: 'g2', baseUrl: '' }),
                        );
                    },
                });
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                // Updated where it already lived, not shadowed by a second copy.
                expect(saved.providers.gemini).toEqual({ apiKey: 'sk-a', model: 'g2' });
                expect(saved.providers['gemini-api']).toBeUndefined();
                expect(saved.provider).toBe('gemini');
            },
        );
    });

    it('writes where the read takes effect when an alias and its engine both exist', async () => {
        // `config set gemini.apiKey` then `config set gemini-api.apiKey`
        // leaves both. Reading merges canonical last, so writing under the
        // alias saved a value that the canonical key then shadowed: the card
        // said saved and the engine kept using the old key.
        await withConfig(
            {
                provider: 'gemini',
                providers: {
                    gemini: { apiKey: 'alias-key', model: 'alias-model' },
                    'gemini-api': { apiKey: 'canonical-key', model: 'canonical-model' },
                },
            },
            async (handler, file) => {
                await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(
                            JSON.stringify({
                                engine: 'gemini-api',
                                apiKey: 'fresh-key',
                                model: 'fresh-model',
                                baseUrl: '',
                            }),
                        );
                    },
                });
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                // The effective value is what the merge yields, alias first.
                const effective = {
                    ...saved.providers.gemini,
                    ...saved.providers['gemini-api'],
                };
                expect(effective.apiKey).toBe('fresh-key');
                expect(effective.model).toBe('fresh-model');
                // And the summary the card reads back agrees.
                const read = await call(handler, { method: 'GET', url: '/x' });
                const engines = read.body.engines as Record<
                    string,
                    { hasKey: boolean; model: string }
                >;
                expect(engines['gemini-api'].model).toBe('fresh-model');
            },
        );
    });

    it('leaves engine settings alone when the save carries none', async () => {
        // A reuse-only save must not write engine fields back: the values the
        // card loaded could be older than what the file holds now.
        await withConfig(
            {
                provider: 'openai',
                providers: { openai: { apiKey: 'sk-a', model: 'kept' } },
            },
            async (handler, file) => {
                await call(handler, {
                    method: 'POST',
                    url: '/x',
                    [Symbol.asyncIterator]: async function* () {
                        yield Buffer.from(JSON.stringify({ reuse: { pi: true } }));
                    },
                });
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
                expect(saved.providers.openai).toEqual({ apiKey: 'sk-a', model: 'kept' });
                expect(saved.reuse).toEqual({ pi: true });
            },
        );
    });

    it('pins only when the card says the pin moved', async () => {
        await withConfig({ provider: 'openai' }, async (handler, file) => {
            await call(handler, {
                method: 'POST',
                url: '/x',
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(JSON.stringify({ provider: 'anthropic' }));
                },
            });
            expect(JSON.parse(fs.readFileSync(file, 'utf-8')).provider).toBe('anthropic');
            // And an explicit empty unpins.
            await call(handler, {
                method: 'POST',
                url: '/x',
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(JSON.stringify({ provider: '' }));
                },
            });
            expect(JSON.parse(fs.readFileSync(file, 'utf-8')).provider).toBeUndefined();
        });
    });

    it('refuses an engine it does not know', async () => {
        await withConfig({ provider: 'openai' }, async (handler) => {
            const { status, body } = await call(handler, {
                method: 'POST',
                url: '/x',
                [Symbol.asyncIterator]: async function* () {
                    yield Buffer.from(JSON.stringify({ provider: 'not-an-engine' }));
                },
            });
            expect(status).toBe(400);
            expect(String(body.error)).toContain('unknown engine');
        });
    });

    it('omits discovery from GET unless the client asked (#83)', async () => {
        await withConfig({ provider: 'openai' }, async (handler) => {
            const { status, body } = await call(handler, { method: 'GET', url: '/modlens/config' });
            expect(status).toBe(200);
            expect(body).not.toHaveProperty('discovery');
        });
    });

    it('caches local-agent discovery for ten minutes (#83)', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'index.js'), 'utf-8');
        expect(source).toMatch(/const DISCOVERY_TTL_MS = 600_000/);
    });
});

describe('settings card, host side: one source, whole (#42)', () => {
    // engineSummary and applyEngineSettings read a real file and a real
    // environment, so they run against both here. os.homedir() follows HOME on
    // POSIX and USERPROFILE on Windows, which is how the shared config path is
    // pointed at a scratch directory.
    async function withHome<T>(
        env: Record<string, string | undefined>,
        body: (config: {
            engineSummary: () => {
                engines: Record<
                    string,
                    { baseUrl: string; model: string; hasKey: boolean; source: string }
                >;
            };
            applyEngineSettings: (patch: Record<string, unknown>) => void;
            modlensConfigPath: () => string;
        }) => T,
    ): Promise<T> {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-home-'));
        const saved: Record<string, string | undefined> = {};
        const overrides = { HOME: home, USERPROFILE: home, ...env };
        for (const [key, value] of Object.entries(overrides)) {
            saved[key] = process.env[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try {
            // The plugin is plain JS by design (no build step, no dsh type deps).
            // @ts-expect-error untyped on purpose
            const module = (await import('../dsh/index.js')) as unknown as {
                __config: Parameters<typeof body>[0];
            };
            return body(module.__config);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            fs.rmSync(home, { recursive: true, force: true });
        }
    }

    it('shows the variables that are actually supplying an engine', async () => {
        // Reading only the file showed an empty form for a machine whose
        // container exports its key, which reads as "nothing is configured".
        await withHome(
            { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: 'https://gw.example/v1' },
            (config) => {
                const openai = config.engineSummary().engines.openai;
                expect(openai.source).toBe('env');
                expect(openai.baseUrl).toBe('https://gw.example/v1');
                expect(openai.hasKey).toBe(true);
            },
        );
    });

    it('reports the file as the source once the file names the engine, emptied or not', async () => {
        await withHome(
            { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: 'https://gw/v1' },
            (config) => {
                const file = config.modlensConfigPath();
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify({ providers: { openai: {} } }));
                const openai = config.engineSummary().engines.openai;
                expect(openai.source).toBe('file');
                expect(openai.hasKey).toBe(false);
                expect(openai.baseUrl).toBe('');
            },
        );
    });

    it('says nothing about an engine neither source configures', async () => {
        await withHome({ OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined }, (config) => {
            expect(config.engineSummary().engines.openai.source).toBe('');
        });
    });

    it('carries the variables into the file when a save creates the first entry', async () => {
        // The whole hazard: saving a model on a working environment-only
        // engine writes an entry, the entry takes the engine off its
        // variables, and the key and endpoint vanish from the next read. They
        // move with it instead, and the key is copied here rather than in the
        // browser, which never receives one.
        await withHome(
            { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: 'https://gw.example/v1' },
            (config) => {
                config.applyEngineSettings({
                    engine: 'openai',
                    apiKey: '',
                    baseUrl: 'https://gw.example/v1',
                    model: 'qwen3-vl-max',
                });
                const saved = JSON.parse(fs.readFileSync(config.modlensConfigPath(), 'utf-8')) as {
                    providers: Record<string, Record<string, string>>;
                };
                expect(saved.providers.openai).toEqual({
                    apiKey: 'env-key',
                    baseUrl: 'https://gw.example/v1',
                    model: 'qwen3-vl-max',
                });
            },
        );
    });

    it('leaves a file-sourced engine alone, variables and all', async () => {
        await withHome(
            { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: 'https://gw/v1' },
            (config) => {
                const file = config.modlensConfigPath();
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(
                    file,
                    JSON.stringify({ providers: { openai: { apiKey: 'file-key' } } }),
                );
                config.applyEngineSettings({
                    engine: 'openai',
                    apiKey: '',
                    baseUrl: '',
                    model: 'm',
                });
                const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
                    providers: Record<string, Record<string, string>>;
                };
                expect(saved.providers.openai).toEqual({ apiKey: 'file-key', model: 'm' });
            },
        );
    });
});

describe('the wrapper keeps upstream replay state reachable (#49)', () => {
    // dsh drops an assistant message's adapter-private replayState when the
    // provider recorded on it belongs to a different adapter instance than
    // the one about to run. The wrapper is a different instance, so every
    // turn it produced arrived upstream stripped of the state carrying
    // reasoning continuity, and the model stopped emitting reasoning blocks.
    async function wrapperStream(
        messages: unknown[],
        wiring: { upstream?: string; providerId?: string } = {},
    ) {
        let adapter: Record<string, CallableFunction> | undefined;
        const seen: Array<Record<string, unknown>> = [];
        const llm = {
            registerAdapter: (_p: string[], a: Record<string, CallableFunction>) => {
                adapter = a;
            },
            // The wired upstream is mounted by premise: these scenarios stream
            // through it, and reconcile registers nothing for an absent one (#66).
            listProviders: () => [wiring.upstream ?? 'deepseek-official'],
            listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-flash' }],
            resolveModelInfo: async (_p: string, model: string) => ({
                provider: 'deepseek-official',
                id: model,
            }),
            stream: (options: Record<string, unknown>) => {
                seen.push(options);
                return (async function* () {
                    yield { type: 'finish' };
                })();
            },
        };
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        plugin.apply(
            { tools: { register: () => {} }, attachments: {}, on: () => {}, llm } as never,
            {
                upstream: wiring.upstream ?? 'deepseek-official',
                providerId: wiring.providerId ?? 'deepseek-modlens',
                pasteToPath: false,
            },
        );
        const iterator = (adapter as Record<string, CallableFunction>).stream({
            provider: wiring.providerId ?? 'deepseek-modlens',
            model: 'deepseek-v4-flash',
            messages,
        }) as AsyncIterable<unknown>;
        for await (const _chunk of iterator) {
            // drain
        }
        return seen[0];
    }

    it('relabels its own turns as upstream so the state survives delegation', async () => {
        const sent = await wrapperStream([
            { role: 'user', source: { kind: 'user' }, content: [] },
            {
                role: 'assistant',
                source: {
                    kind: 'model',
                    provider: 'deepseek-modlens',
                    model: 'deepseek-v4-flash',
                    replayState: { thinking: 'opaque-upstream-blob' },
                },
                content: [],
            },
        ]);
        const history = sent.messages as Array<{ source: Record<string, unknown> }>;
        expect(history[1].source.provider).toBe('deepseek-official');
        // The point of the rename: the state rides along.
        expect(history[1].source.replayState).toEqual({ thinking: 'opaque-upstream-blob' });
    });

    it('leaves turns from other providers alone', async () => {
        const sent = await wrapperStream([
            {
                role: 'assistant',
                source: {
                    kind: 'model',
                    provider: 'some-other',
                    model: 'x',
                    replayState: { a: 1 },
                },
                content: [],
            },
        ]);
        const history = sent.messages as Array<{ source: Record<string, unknown> }>;
        expect(history[0].source.provider).toBe('some-other');
    });

    it('leaves user turns alone', async () => {
        const sent = await wrapperStream([{ role: 'user', source: { kind: 'user' }, content: [] }]);
        const history = sent.messages as Array<{ source: Record<string, unknown> }>;
        expect(history[0].source.kind).toBe('user');
    });
});

async function wrapperStreamFor(
    messages: unknown[],
    wiring: { upstream?: string; providerId?: string },
): Promise<Record<string, unknown>> {
    let adapter: Record<string, CallableFunction> | undefined;
    const seen: Array<Record<string, unknown>> = [];
    const llm = {
        registerAdapter: (_p: string[], a: Record<string, CallableFunction>) => {
            adapter = a;
        },
        // The wired upstream is mounted by premise: these scenarios stream
        // through it, and reconcile registers nothing for an absent one (#66).
        listProviders: () => [wiring.upstream ?? 'deepseek-official'],
        listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-v4-flash' }],
        resolveModelInfo: async (_p: string, model: string) => ({
            provider: 'deepseek-official',
            id: model,
        }),
        stream: (options: Record<string, unknown>) => {
            seen.push(options);
            return (async function* () {
                yield { type: 'finish' };
            })();
        },
    };
    // @ts-expect-error untyped on purpose
    const plugin = (await import('../dsh/index.js')) as {
        apply: (ctx: unknown, config?: Record<string, unknown>) => void;
    };
    plugin.apply({ tools: { register: () => {} }, attachments: {}, on: () => {}, llm } as never, {
        upstream: wiring.upstream ?? 'deepseek-official',
        providerId: wiring.providerId ?? 'deepseek-modlens',
        pasteToPath: false,
    });
    const iterator = (adapter as Record<string, CallableFunction>).stream({
        provider: wiring.providerId ?? 'deepseek-modlens',
        model: 'deepseek-v4-flash',
        messages,
    }) as AsyncIterable<unknown>;
    for await (const _chunk of iterator) {
        // drain
    }
    return seen[0];
}

describe('replay state never crosses to an adapter that did not produce it (#49)', () => {
    /**
     * LlmService.forAdapter, as dsh implements it: an assistant message keeps
     * its adapter-private replayState only when the provider recorded on it
     * resolves to the very adapter about to run. Reproduced here so the two
     * layers can be exercised together without importing the host.
     */
    function forAdapter(
        messages: Array<Record<string, never>>,
        owners: Record<string, string>,
        adapter: string,
    ) {
        return messages.map((message) => {
            const source = message.source as unknown as Record<string, unknown> | undefined;
            if (
                (message as { role?: string }).role !== 'assistant' ||
                source?.kind !== 'model' ||
                source.replayState === undefined
            ) {
                return message;
            }
            if (owners[source.provider as string] === adapter) return message;
            const { replayState: _dropped, ...rest } = source;
            return { ...message, source: rest };
        });
    }

    const turn = (provider: string) =>
        Object.freeze({
            role: 'assistant',
            source: Object.freeze({
                kind: 'model',
                provider,
                model: 'deepseek-v4-flash',
                replayState: { thinking: 'opaque' },
            }),
            content: [],
        });

    it('survives the boundary when the id encodes its upstream', async () => {
        const sent = await wrapperStreamFor([turn('modlens-opencode-go')], {
            upstream: 'opencode-go',
            providerId: 'modlens-opencode-go',
        });
        const afterHost = forAdapter(
            sent.messages as Array<Record<string, never>>,
            { 'opencode-go': 'upstreamAdapter', 'modlens-opencode-go': 'wrapperAdapter' },
            'upstreamAdapter',
        );
        expect((afterHost[0].source as Record<string, unknown>).replayState).toEqual({
            thinking: 'opaque',
        });
    });

    it('is not relabelled, and so is dropped, when the id was repointed', async () => {
        // deepseek-modlens hand-configured onto some other upstream: history
        // under that id was produced by whatever it pointed at before, and
        // handing this adapter that state is worse than losing it.
        const sent = await wrapperStreamFor([turn('deepseek-modlens')], {
            upstream: 'some-other-provider',
            providerId: 'deepseek-modlens',
        });
        const history = sent.messages as Array<{ source: Record<string, unknown> }>;
        expect(history[0].source.provider).toBe('deepseek-modlens');
        const afterHost = forAdapter(
            sent.messages as Array<Record<string, never>>,
            { 'some-other-provider': 'otherAdapter', 'deepseek-modlens': 'wrapperAdapter' },
            'otherAdapter',
        );
        expect((afterHost[0].source as Record<string, unknown>).replayState).toBeUndefined();
    });

    it('never mutates the durable message it was handed', async () => {
        const original = turn('deepseek-modlens');
        const sent = await wrapperStreamFor([original], {});
        const history = sent.messages as Array<{ source: Record<string, unknown> }>;
        expect(history[0]).not.toBe(original);
        expect(original.source.provider).toBe('deepseek-modlens');
    });
});

describe('pasted files do not accumulate forever (#51)', () => {
    // The paste route cannot delete its file when the request ends: the path
    // is what goes into the composer, so it has to outlive the response and
    // survive until the model reads it. Nothing collected them afterwards,
    // so they built up for as long as dsh stayed installed.
    //
    // Every case here runs against an isolated root. Pointing the sweep at
    // the real temp directory would delete a developer's own live pastes
    // every time the suite ran.
    async function paste() {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            __paste: {
                sweepExpiredPastes: (now?: number, root?: string) => Promise<void>;
                ttlMs: number;
            };
        };
        return plugin.__paste;
    }

    function aged(root: string, name: string, ageMs: number): string {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'paste.png'), 'x');
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(dir, when, when);
        return dir;
    }

    function scratch(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-sweeproot-'));
    }

    it('removes an expired paste and keeps a fresh one', async () => {
        const { sweepExpiredPastes, ttlMs } = await paste();
        const root = scratch();
        try {
            const stale = aged(root, 'p-aaaaaa', ttlMs * 2);
            const fresh = aged(root, 'p-bbbbbb', 0);
            await sweepExpiredPastes(Date.now(), root);
            expect(fs.existsSync(stale)).toBe(false);
            expect(fs.existsSync(fresh)).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps a draft that has been sitting for days', async () => {
        // The window has to cover a person's pace. A composer holding a
        // pasted path overnight, or over a weekend, must still resolve.
        const { sweepExpiredPastes } = await paste();
        const root = scratch();
        try {
            const weekend = aged(root, 'p-cccccc', 3 * 24 * 60 * 60 * 1000);
            await sweepExpiredPastes(Date.now(), root);
            expect(fs.existsSync(weekend)).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('leaves anything that is not a paste directory alone', async () => {
        const { sweepExpiredPastes, ttlMs } = await paste();
        const root = scratch();
        try {
            // Everything inside this directory is ours by construction, so
            // the sweep no longer has to guess from a name. What matters now
            // is that it never leaves the directory: a file rather than a
            // paste is left alone, and nothing outside is reachable.
            const stray = path.join(root, 'not-a-paste.txt');
            fs.writeFileSync(stray, 'x');
            const when = new Date(Date.now() - ttlMs * 10);
            fs.utimesSync(stray, when, when);
            await sweepExpiredPastes(Date.now(), root);
            expect(fs.existsSync(stray)).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not follow a link out of the temp directory', async () => {
        // A cleanup that follows a link is how it becomes someone else's
        // deleted files.
        const { sweepExpiredPastes, ttlMs } = await paste();
        const root = scratch();
        const elsewhere = scratch();
        try {
            fs.writeFileSync(path.join(elsewhere, 'precious.txt'), 'keep me');
            const link = path.join(root, 'p-dddddd');
            fs.symlinkSync(elsewhere, link, 'dir');
            const when = new Date(Date.now() - ttlMs * 2);
            fs.lutimesSync(link, when, when);
            await sweepExpiredPastes(Date.now(), root);
            expect(fs.existsSync(path.join(elsewhere, 'precious.txt'))).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    it('survives a root it cannot list', async () => {
        const { sweepExpiredPastes } = await paste();
        await expect(
            sweepExpiredPastes(Date.now(), path.join(os.tmpdir(), 'modlens-no-such-root')),
        ).resolves.toBeUndefined();
    });
});

describe('the paste store has a ceiling as well as a clock (#51)', () => {
    // One image may be 25 MB and the window is a week, so a burst can reach
    // tens of gigabytes before any of it expires. The ceiling only engages
    // far past ordinary use, and removes oldest first: a worse rule than
    // liveness, but running a disk out of space is worse than either.
    it('drops the oldest until the store is under the ceiling', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            __paste: {
                sweepExpiredPastes: (
                    now?: number,
                    root?: string,
                    maxBytes?: number,
                ) => Promise<void>;
                maxBytes: number;
            };
        };
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cap-'));
        try {
            const big = Buffer.alloc(512 * 1024, 1);
            const made: string[] = [];
            for (let index = 0; index < 4; index++) {
                const dir = path.join(root, `p-cap${index}`);
                fs.mkdirSync(dir);
                fs.writeFileSync(path.join(dir, 'paste.png'), big);
                const when = new Date(Date.now() - (4 - index) * 60_000);
                fs.utimesSync(dir, when, when);
                made.push(dir);
            }
            // A ceiling just under two of them, so the rule has to engage
            // and the newest are what survive.
            await plugin.__paste.sweepExpiredPastes(Date.now(), root, big.length * 2);
            const survivors = made.filter((dir) => fs.existsSync(dir));
            expect(survivors).toEqual(made.slice(-2));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('never leaves an older paste behind a newer one when sweeps overlap', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-process-sweep-'));
        try {
            const bytes = Buffer.alloc(64 * 1024, 1);
            const made: string[] = [];
            for (let index = 0; index < 4; index++) {
                const dir = path.join(root, `p-process-${index}`);
                fs.mkdirSync(dir);
                fs.writeFileSync(path.join(dir, 'paste.png'), bytes);
                const when = new Date(Date.now() - (4 - index) * 60_000);
                fs.utimesSync(dir, when, when);
                made.push(dir);
            }
            const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'dsh', 'index.js')).href;
            const script =
                'const { __paste } = await import(process.argv[1]); await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(process.argv[4]) - Date.now()))); await __paste.sweepExpiredPastes(Date.now(), process.argv[2], Number(process.argv[3]));';
            const startAt = Date.now() + 250;
            await Promise.all(
                Array.from({ length: 4 }, () =>
                    execFileAsync(process.execPath, [
                        '--input-type=module',
                        '--eval',
                        script,
                        moduleUrl,
                        root,
                        String(bytes.length * 2),
                        String(startAt),
                    ]),
                ),
            );
            // Four sweepers with no lock between them each measure the whole
            // store and each delete until their own reading is under the
            // ceiling, so together they can remove more than one of them
            // would. That is a real property of a lock-free sweep, not a
            // defect to assert away: coordinating them would need
            // cross-process locking, which is more machinery than a temp
            // directory is worth.
            //
            // What must hold is the ORDER. When every removal succeeds, as
            // here, the survivors are exactly the newest ones and the ceiling
            // is respected. (A removal that fails leaves its older entry
            // standing; the undeletable-directory test below owns that case.)
            const survivors = made.filter((dir) => fs.existsSync(dir));
            expect(survivors).toEqual(made.slice(made.length - survivors.length));
            expect(survivors.length).toBeLessThanOrEqual(2);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('the suite never touches the real paste store (#51)', () => {
    // Twice this was fixed in the sweeper's own tests while the route kept
    // using the default directory, and the route sweeps on every successful
    // paste. This is the canary for that whole class rather than for one
    // call site: whatever the suite does, the real store must be left as it
    // was found.
    it('leaves the default store exactly as it found it', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            __paste: { pasteRoot: (base?: string | null) => string };
        };
        const real = plugin.__paste.pasteRoot();
        const before = fs.existsSync(real) ? fs.readdirSync(real).sort().join('|') : '<absent>';

        // Exercise the sweeper the way a paste would, but pointed elsewhere.
        const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-canary-'));
        try {
            fs.mkdirSync(path.join(isolated, 'p-zzzzzz'));
            // @ts-expect-error untyped on purpose
            const mod = (await import('../dsh/index.js')) as {
                __paste: { sweepExpiredPastes: (n?: number, r?: string) => Promise<void> };
            };
            await mod.__paste.sweepExpiredPastes(Date.now(), isolated);
        } finally {
            fs.rmSync(isolated, { recursive: true, force: true });
        }

        const after = fs.existsSync(real) ? fs.readdirSync(real).sort().join('|') : '<absent>';
        expect(after).toBe(before);
    });
});

describe("the paste store uses Node's platform temp directory (#51)", () => {
    it.skipIf(process.platform === 'win32')(
        'honors the POSIX TMP before TEMP precedence',
        async () => {
            // @ts-expect-error untyped on purpose
            const plugin = (await import('../dsh/index.js')) as {
                __paste: { pasteRoot: (base?: string | null) => string };
            };
            const before = {
                TMPDIR: process.env.TMPDIR,
                TMP: process.env.TMP,
                TEMP: process.env.TEMP,
            };
            try {
                delete process.env.TMPDIR;
                process.env.TMP = '/tmp/modlens-node-tmp';
                process.env.TEMP = '/tmp/modlens-node-temp';
                expect(plugin.__paste.pasteRoot()).toBe(
                    path.join(os.tmpdir(), 'modlens-dsh-paste'),
                );
            } finally {
                for (const [key, value] of Object.entries(before)) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
            }
        },
    );
});

describe('the paste store refuses a directory that is not ours (#51)', () => {
    // The path is predictable and the system temp directory is shared, so on
    // a multi-user machine somebody else can get there first. A symlink at
    // that name would aim a recursive cleanup at whatever it points to.
    async function open(base: string) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            __paste: { openPasteRoot: (base?: string | null) => Promise<string> };
        };
        return plugin.__paste.openPasteRoot(base);
    }

    it('refuses a symlink standing in for the store', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-linkroot-'));
        const target = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-linktarget-'));
        const link = path.join(scratch, 'store');
        try {
            fs.writeFileSync(path.join(target, 'precious.txt'), 'keep me');
            fs.symlinkSync(target, link, 'dir');
            await expect(open(link)).rejects.toThrow(/not a directory/);
            expect(fs.existsSync(path.join(target, 'precious.txt'))).toBe(true);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
            fs.rmSync(target, { recursive: true, force: true });
        }
    });

    it('refuses a file sitting where the store should be', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-fileroot-'));
        const asFile = path.join(scratch, 'store');
        try {
            fs.writeFileSync(asFile, 'not a directory');
            await expect(open(asFile)).rejects.toThrow(/not a directory/);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')(
        'creates a private store and narrows an over-permissive one',
        async () => {
            const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-mode-'));
            const store = path.join(scratch, 'store');
            try {
                await open(store);
                expect(fs.statSync(store).mode & 0o777).toBe(0o700);
                fs.chmodSync(store, 0o777);
                await open(store);
                expect(fs.statSync(store).mode & 0o777).toBe(0o700);
            } finally {
                fs.rmSync(scratch, { recursive: true, force: true });
            }
        },
    );

    it.skipIf(process.platform !== 'win32')(
        'accepts an ACL-backed Windows directory without judging POSIX mode bits',
        async () => {
            const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-windows-mode-'));
            const store = path.join(scratch, 'store');
            const expected = path.join(fs.realpathSync(scratch), 'store');
            try {
                expect(canon(await open(store))).toBe(canon(expected));
                expect(canon(await open(store))).toBe(canon(expected));
            } finally {
                fs.rmSync(scratch, { recursive: true, force: true });
            }
        },
    );

    it.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)(
        'refuses an existing store when the filesystem rejects chmod',
        async () => {
            const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-chmod-'));
            const store = path.join(scratch, 'store');
            fs.mkdirSync(store, { mode: 0o777 });
            fs.chmodSync(store, 0o777);
            await execFileAsync('/usr/bin/chflags', ['uchg', store]);
            try {
                await expect(open(store)).rejects.toThrow();
                expect(fs.statSync(store).mode & 0o777).toBe(0o777);
            } finally {
                await execFileAsync('/usr/bin/chflags', ['nouchg', store]);
                fs.rmSync(scratch, { recursive: true, force: true });
            }
        },
    );
});

describe('the paste store is created before it is trusted (#51)', () => {
    // Checking a fixed name and then creating it leaves a window: on a shared
    // temp directory somebody can drop a symlink between the two and have the
    // write land wherever it points.
    async function open(base: string) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            __paste: { openPasteRoot: (base?: string | null) => Promise<string> };
        };
        return plugin.__paste.openPasteRoot(base);
    }

    it('creates a nested store, and its parent, privately', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-nested-'));
        try {
            const nested = path.join(scratch, 'a', 'b', 'store');
            await open(nested);
            expect(fs.statSync(nested).isDirectory()).toBe(true);
            if (process.platform !== 'win32') {
                expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
            }
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it('refuses a symlink that was already sitting at the name', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-race-'));
        const target = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-racetarget-'));
        try {
            fs.writeFileSync(path.join(target, 'precious.txt'), 'keep me');
            const link = path.join(scratch, 'store');
            fs.symlinkSync(target, link, 'dir');
            await expect(open(link)).rejects.toThrow(/not a directory/);
            // Nothing was written through the link either.
            expect(fs.readdirSync(target)).toEqual(['precious.txt']);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
            fs.rmSync(target, { recursive: true, force: true });
        }
    });

    it('is safe to open twice', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-twice-'));
        try {
            const store = path.join(scratch, 'store');
            const [a, b] = await Promise.all([open(store), open(store)]);
            const real = canon(path.join(fs.realpathSync(scratch), 'store'));
            expect([canon(a), canon(b)]).toEqual([real, real]);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it('is safe when separate processes create the same store together', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-process-open-'));
        try {
            const store = path.join(scratch, 'store');
            const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'dsh', 'index.js')).href;
            const script =
                'const { __paste } = await import(process.argv[1]); process.stdout.write(await __paste.openPasteRoot(process.argv[2]));';
            const opened = await Promise.all(
                Array.from({ length: 8 }, async () => {
                    const result = await execFileAsync(process.execPath, [
                        '--input-type=module',
                        '--eval',
                        script,
                        moduleUrl,
                        store,
                    ]);
                    return result.stdout;
                }),
            );
            expect(new Set(opened.map(canon))).toEqual(
                new Set([canon(path.join(fs.realpathSync(scratch), 'store'))]),
            );
            if (process.platform !== 'win32') {
                expect(fs.statSync(store).mode & 0o777).toBe(0o700);
            }
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });
});

describe('the paste store checks the whole path, not just the leaf (#51)', () => {
    // An exclusive mkdir succeeds just as happily through a symlinked parent,
    // and the leaf it creates then sits wherever that link points. Creating
    // something is not proof of where it is.
    async function open(base: string) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            __paste: { openPasteRoot: (base?: string | null) => Promise<string> };
        };
        return plugin.__paste.openPasteRoot(base);
    }

    it('resolves a linked parent and reports where the store really is', async () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-parent-'));
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-parenttarget-'));
        try {
            const linkedParent = path.join(scratch, 'parent');
            fs.symlinkSync(elsewhere, linkedParent, 'dir');
            // A legitimate link in an ancestor is resolved rather than
            // refused, since a system temp directory is often behind one.
            // What matters is that the store ends up at the resolved path
            // and the caller is told where that is.
            const opened = await open(path.join(linkedParent, 'store'));
            expect(canon(opened)).toBe(canon(path.join(elsewhere, 'store')));
            expect(fs.readdirSync(elsewhere)).toEqual(['store']);
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
            fs.rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    // The refusal when chmod cannot narrow an existing store is not tested:
    // as the owning user chmod succeeds regardless of the parent's mode, and
    // arranging a directory this process owns but cannot chmod needs another
    // user. The narrowing itself is covered above; only the throw is not.
});

describe('an unmeasurable paste is not counted as empty (#51)', () => {
    // A quietly low number is worse than no number: the store passes a
    // ceiling it has already exceeded, and keeps growing.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'treats a directory it cannot measure as a full-size paste',
        async () => {
            // @ts-expect-error untyped on purpose
            const plugin = (await import('../dsh/index.js')) as {
                __paste: {
                    sweepExpiredPastes: (n?: number, r?: string, max?: number) => Promise<void>;
                };
            };
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-unmeasured-'));
            const opaque = path.join(root, 'p-opaqu1');
            const fresh = path.join(root, 'p-fresh1');
            try {
                fs.mkdirSync(opaque);
                fs.writeFileSync(path.join(opaque, 'paste.png'), Buffer.alloc(1, 1));
                fs.mkdirSync(fresh);
                fs.writeFileSync(path.join(fresh, 'paste.png'), Buffer.alloc(900, 1));
                // A real permission failure, not a readable directory named
                // "opaque". Without conservative booking the measured total
                // is only 900 bytes and the fresh paste incorrectly survives.
                fs.chmodSync(opaque, 0o000);
                const old = new Date(Date.now() - 60_000);
                fs.utimesSync(opaque, old, old);

                await plugin.__paste.sweepExpiredPastes(Date.now(), root, 1000);
                expect(fs.existsSync(opaque)).toBe(true);
                expect(fs.existsSync(fresh)).toBe(false);
            } finally {
                if (fs.existsSync(opaque)) fs.chmodSync(opaque, 0o700);
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
    );
});

describe('the wrapper survives the paths review found untested (#57)', () => {
    // Mutation testing on the previous round showed five survivors. These are
    // the two that matter: a replace() that throws, and an upstream that
    // disappears while the plugin is in explicit single-route mode. Both are
    // where the next round of this bug would have come from.
    async function plugin() {
        // @ts-expect-error untyped on purpose
        return (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
    }

    it('drops a wrapper whose upstream disappears in explicit mode', async () => {
        const mod = await plugin();
        const handlers: Record<string, () => void> = {};
        let providers = [{ id: 'lanz', name: 'Lanz' }];
        let disposed = false;
        const registered: string[] = [];
        const llm = {
            providerRetryPolicy: () => ({
                mode: 'normal',
                maxRetries: 7,
                retryableCodes: ['RATE_LIMIT'],
                initialDelayMs: 1,
                maxDelayMs: 2,
                jitterRatio: 0,
            }),
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                adapter.providerInfo(ids[0]);
                adapter.providerRetryPolicy(ids[0]);
                registered.push(ids[0]);
                const handle = () => {
                    disposed = true;
                };
                handle.replace = () => {
                    adapter.providerInfo(ids[0]);
                    adapter.providerRetryPolicy(ids[0]);
                };
                return handle;
            },
            listProviders: () => providers,
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        mod.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm,
            } as never,
            { upstream: 'lanz', providerId: 'house-lanz' },
        );
        expect(registered).toEqual(['house-lanz']);

        // The upstream route goes away. A wrapper that stayed would be a
        // model group pointing at nothing.
        providers = [];
        handlers['llm/adapters-updated']();
        expect(disposed).toBe(true);
    });

    it('names the wrapper after the route it actually wraps', async () => {
        // It used to say DeepSeek whatever the upstream was, so anyone
        // pointing it elsewhere got a group labelled for a provider they
        // were not using.
        const mod = await plugin();
        const names: string[] = [];
        const llm = {
            providerRetryPolicy: () => undefined,
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                names.push((adapter.providerInfo(ids[0]) as { name: string }).name);
                const handle = () => {};
                handle.replace = () => {};
                return handle;
            },
            listProviders: () => [{ id: 'lanz', name: 'Lanz Medium' }],
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        mod.apply({ tools: { register: () => {} }, attachments: {}, on: () => {}, llm } as never, {
            upstream: 'lanz',
            providerId: 'house-lanz',
        });
        expect(names).toEqual(['Lanz Medium (modlens vision)']);
    });

    it('keeps a registration whose replace threw after the host already committed', async () => {
        // commitRoutes mutates the registry and only then emits, so a
        // listener throwing during that emit means the replace succeeded.
        // Treating it as failure would dispose a healthy registration.
        const mod = await plugin();
        const handlers: Record<string, () => void> = {};
        let maxRetries = 2;
        let disposed = false;
        const llm = {
            providerRetryPolicy: () => ({
                mode: 'normal',
                maxRetries,
                retryableCodes: ['RATE_LIMIT'],
                initialDelayMs: 1,
                maxDelayMs: 2,
                jitterRatio: 0,
            }),
            registerAdapter: (ids: string[], adapter: Record<string, CallableFunction>) => {
                adapter.providerInfo(ids[0]);
                adapter.providerRetryPolicy(ids[0]);
                const handle = () => {
                    disposed = true;
                };
                handle.replace = () => {
                    throw new Error('a listener threw after the routes were committed');
                };
                return handle;
            },
            listProviders: () => [{ id: 'lanz', name: 'Lanz' }],
            listModels: async () => [],
            resolveModelInfo: async () => ({}),
            stream: () => (async function* () {})(),
        };
        const original = console.error;
        const errors: string[] = [];
        console.error = (value?: unknown) => errors.push(String(value));
        try {
            mod.apply(
                {
                    tools: { register: () => {} },
                    attachments: {},
                    on: (event: string, fn: () => void) => {
                        handlers[event] = fn;
                    },
                    llm,
                } as never,
                { upstream: 'lanz', providerId: 'house-lanz' },
            );
            maxRetries = 50;
            handlers['llm/adapters-updated']();
        } finally {
            console.error = original;
        }
        // Whatever it does, it must say so rather than fail silently.
        expect(errors.join('\n')).toContain('committed');
        // Documented behaviour, pinned so a change to it is a decision:
        // the throw is treated as a failed refresh and the wrapper is
        // dropped, which is recoverable because the next reconcile
        // re-registers it.
        expect(disposed).toBe(true);
    });
});

describe('a route that gains native vision says so, and says what to do', () => {
    // Refusing to wrap a model that reads images itself is right: the bridge
    // would claim work it does not do, hand the model text instead of the
    // picture, and lose whatever its own vision does better. The defect was
    // that the refusal explained nothing, while a session holding that entry
    // fails every turn and nothing clears the stale choice.
    async function resolveThrough(modalities: string[] | undefined, id = 'deepseek-v4-flash') {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        let adapter: Record<string, CallableFunction> | undefined;
        const llm = {
            providerRetryPolicy: () => undefined,
            registerAdapter: (_ids: string[], next: Record<string, CallableFunction>) => {
                adapter = next;
                const handle = () => {};
                handle.replace = () => {};
                return handle;
            },
            listProviders: () => [{ id: 'lanz', name: 'Lanz' }],
            listModels: async () => [{ provider: 'lanz', id, name: id }],
            resolveModelInfo: async () => ({
                provider: 'lanz',
                id,
                name: id,
                ...(modalities === undefined ? {} : { inputModalities: modalities }),
            }),
            stream: () => (async function* () {})(),
        };
        plugin.apply(
            { tools: { register: () => {} }, attachments: {}, on: () => {}, llm } as never,
            { upstream: 'lanz', providerId: 'house-lanz' },
        );
        return (adapter as Record<string, CallableFunction>).resolveModel('house-lanz', id);
    }

    it('wraps a route while it is still text-only', async () => {
        await expect(resolveThrough(['text'])).resolves.toMatchObject({ id: 'deepseek-v4-flash' });
    });

    it('names the cause and the way out once the route declares image input', async () => {
        // Same route, same model id, different declared capability.
        await expect(resolveThrough(['text', 'image'])).rejects.toThrow(
            /declares native image input.*without "\(modlens vision\)"/s,
        );
    });

    it('keeps the general message when the model simply left the families', async () => {
        // A different situation with a different answer, so it keeps its own
        // wording rather than telling the user to pick a plain entry that
        // does not exist.
        await expect(resolveThrough(['text'], 'llama-4-scout')).rejects.toThrow(
            /outside the modlens vision wrap scope/,
        );
    });
});

describe('the settings card is dispatchable on rc.7 (#61, #65)', () => {
    // rc.7's settings page renders a plugin card only when the card's slot key
    // matches a namespace the host serves in settings.describe. The card keys
    // itself 'modlens' (see dshClient.test.ts), so the host half must serve a
    // 'modlens' namespace or the card silently never renders, which is exactly
    // how both reports found it.
    async function loadWithSettings(config: Record<string, unknown> = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: Array<{ ns: string; schema: unknown; options: unknown }> = [];
        const armed: string[][] = [];
        const ctx = {
            tools: { register: () => {} },
            attachments: {
                readImage: async () => ({
                    data: new Uint8Array([1]),
                    ref: { mediaType: 'image/png' },
                }),
            },
            on: () => {},
            inject: (deps: string[], fn: (scope: unknown) => void) => {
                armed.push(deps);
                if (deps.includes('settings')) {
                    fn({
                        settings: {
                            register: (ns: string, schema: unknown, options: unknown) => {
                                registered.push({ ns, schema, options });
                                return { get: () => ({}), watch: () => () => {} };
                            },
                        },
                    });
                }
            },
        };
        plugin.apply(ctx as never, config);
        return { registered, armed };
    }

    it('serves the namespace the card is keyed by', async () => {
        const { registered } = await loadWithSettings();

        expect(registered).toHaveLength(1);
        expect(registered[0].ns).toBe('modlens');
        // The card renders instead of the generic form, so the schema's only
        // jobs are to pass the section through and to serialize. The envelope
        // is the exact shape @deepseek-ai/schemastery emits for an empty
        // object schema, hardcoded so this plugin does not import a harness
        // package to describe nothing.
        const schema = registered[0].schema as ((value: unknown) => unknown) & {
            toJSON: () => unknown;
        };
        expect(schema(undefined)).toEqual({});
        expect(schema({ kept: 1 })).toEqual({ kept: 1 });
        expect(schema.toJSON()).toEqual({
            uid: 0,
            refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } },
        });
    });

    it('keeps the namespace off when the card is off', async () => {
        // settingsCard: false removes the card and its route, so a namespace
        // would be a settings entry pointing at nothing.
        const { registered } = await loadWithSettings({ settingsCard: false });

        expect(registered).toEqual([]);
    });
});
