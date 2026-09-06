import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

// The browser half (dsh/client.js) is a hand-written script in the
// __ModuleLoader__ bundle protocol — no module exports, browser globals only.
// It is evaluated here with those globals stubbed, which pins the contracts
// no host-route test can see: the capture listener takes a paste over ONLY on
// a host-confirmed text-only verdict, a 404 (route off) stands the client
// down entirely, and the cordis effect removes the listeners.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

interface FetchCall {
    url: string;
    init?: { method?: string; body?: unknown };
}

interface Harness {
    dispatchPaste: (files: Array<{ type: string }>) => {
        prevented: boolean;
        stopped: boolean;
    };
    focusComposer: () => void;
    settle: () => Promise<void>;
    fetchCalls: FetchCall[];
    insertedText: () => string;
    listeners: () => Record<string, number>;
    dispose: () => void;
    setModelLabel: (label: string) => void;
}

function loadClient(options: {
    policy?: (label: string) => { status: number; takeover?: boolean };
    uploadPath?: string;
    postStatus?: number;
}): Harness {
    const fetchCalls: FetchCall[] = [];
    const policy = options.policy ?? (() => ({ status: 200, takeover: false }));
    const uploadPath = options.uploadPath ?? '/tmp/modlens-test/paste.png';
    const postStatus = options.postStatus ?? 200;

    let modelLabel = '';
    let inserted = '';
    const handlers = new Map<string, Set<(event: unknown) => void>>();
    const addListener = (type: string, fn: (event: unknown) => void) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)?.add(fn);
    };
    const removeListener = (type: string, fn: (event: unknown) => void) => {
        handlers.get(type)?.delete(fn);
    };

    const textarea = {
        tagName: 'TEXTAREA',
        value: '',
        focus: () => {},
        dispatchEvent: () => true,
    };

    const documentStub = {
        addEventListener: addListener,
        removeEventListener: removeListener,
        querySelectorAll: () => [
            {
                getAttribute: () => `Select model, current ${modelLabel}`,
            },
        ],
        activeElement: textarea,
        execCommand: (_cmd: string, _ui: boolean, text: string) => {
            inserted += text;
            return true;
        },
    };

    let disposer: (() => void) | undefined;
    const ctx = {
        effect: (factory: () => () => void) => {
            disposer = factory();
        },
    };

    let loaded:
        | { factory: (require: (id: string) => unknown) => { apply: (ctx: unknown) => void } }
        | undefined;
    const windowStub = {
        __ModuleLoader__: {
            load: (definition: {
                factory: (require: (id: string) => unknown) => { apply: (ctx: unknown) => void };
            }) => {
                loaded = definition;
            },
        },
    };

    const fetchStub = (url: string, init?: { method?: string; body?: unknown }) => {
        fetchCalls.push({ url, init });
        if (init?.method === 'POST') {
            return Promise.resolve({
                ok: postStatus >= 200 && postStatus < 300,
                status: postStatus,
                json: () =>
                    Promise.resolve(
                        postStatus >= 200 && postStatus < 300
                            ? { path: uploadPath }
                            : { error: `gone (${postStatus})` },
                    ),
            });
        }
        const label = decodeURIComponent(url.split('model=')[1] ?? '');
        const verdict = policy(label);
        return Promise.resolve({
            ok: verdict.status >= 200 && verdict.status < 300,
            status: verdict.status,
            json: () => Promise.resolve({ takeover: verdict.takeover === true }),
        });
    };

    // The script only reaches for window, document, fetch, and Event; handing
    // them in as parameters keeps the stubbing exact and the file untouched.
    const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
    run(windowStub, documentStub, fetchStub, class {});
    if (!loaded) throw new Error('client.js never called __ModuleLoader__.load');
    loaded.factory(() => ({})).apply(ctx);

    return {
        dispatchPaste: (files) => {
            const flags = { prevented: false, stopped: false };
            const event = {
                clipboardData: {
                    items: files.map((file) => ({
                        kind: 'file',
                        getAsFile: () => ({
                            type: file.type,
                            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
                        }),
                    })),
                },
                preventDefault: () => {
                    flags.prevented = true;
                },
                stopImmediatePropagation: () => {
                    flags.stopped = true;
                },
                target: textarea,
            };
            for (const fn of handlers.get('paste') ?? []) fn(event);
            return flags;
        },
        focusComposer: () => {
            for (const fn of handlers.get('focusin') ?? []) fn({});
        },
        settle: async () => {
            // Drain the promise chains the client starts (policy fetch,
            // upload, insert) without real timers.
            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
            }
        },
        fetchCalls,
        insertedText: () => inserted,
        listeners: () => {
            const counts: Record<string, number> = {};
            for (const [type, set] of handlers) counts[type] = set.size;
            return counts;
        },
        dispose: () => disposer?.(),
        setModelLabel: (label) => {
            modelLabel = label;
        },
    };
}

const IMAGE = [{ type: 'image/png' }];

describe('dsh paste-to-path browser half', () => {
    it('takes a paste over only after the host confirms a text-only model', async () => {
        const harness = loadClient({
            policy: (label) => ({ status: 200, takeover: label.includes('DeepSeek') }),
        });
        harness.setModelLabel('DeepSeek-V4-Flash');

        // First paste: no cached verdict yet — stays native, kicks the fetch.
        const first = harness.dispatchPaste(IMAGE);
        expect(first.prevented).toBe(false);
        await harness.settle();

        // Second paste: verdict cached true — taken over, uploaded, inserted.
        const second = harness.dispatchPaste(IMAGE);
        expect(second.prevented).toBe(true);
        expect(second.stopped).toBe(true);
        await harness.settle();
        expect(harness.insertedText()).toContain('/tmp/modlens-test/paste.png');
        const posts = harness.fetchCalls.filter((call) => call.init?.method === 'POST');
        expect(posts).toHaveLength(1);
    });

    it('never takes over when the host says the model reads images itself', async () => {
        const harness = loadClient({ policy: () => ({ status: 200, takeover: false }) });
        harness.setModelLabel('Qwen2.5-VL');
        harness.focusComposer();
        await harness.settle();
        const paste = harness.dispatchPaste(IMAGE);
        expect(paste.prevented).toBe(false);
        await harness.settle();
        expect(harness.insertedText()).toBe('');
        expect(harness.fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    });

    it('stands down entirely when the route is off (404): no takeover, no more requests', async () => {
        const harness = loadClient({ policy: () => ({ status: 404 }) });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const before = harness.fetchCalls.length;
        const paste = harness.dispatchPaste(IMAGE);
        expect(paste.prevented).toBe(false);
        await harness.settle();
        // The 404 marked the route unavailable: later pastes neither take
        // over nor keep polling the dead endpoint.
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
        await harness.settle();
        expect(harness.fetchCalls.length).toBe(before);
        expect(harness.insertedText()).toBe('');
    });

    it('pastes inside the failure round-trip window are the bounded loss', async () => {
        // Two pastes fired before the 404 settles are both taken (the
        // documented window: one local round-trip); once the failure lands,
        // the client stands down and later pastes go native with no requests.
        const harness = loadClient({
            policy: () => ({ status: 200, takeover: true }),
            postStatus: 404,
        });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const first = harness.dispatchPaste(IMAGE);
        const second = harness.dispatchPaste(IMAGE);
        expect(first.prevented).toBe(true);
        expect(second.prevented).toBe(true);
        await harness.settle();
        const before = harness.fetchCalls.length;
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
        await harness.settle();
        expect(harness.fetchCalls.length).toBe(before);
    });

    it('a POST 404 after a confirmed verdict stands the client down for good', async () => {
        // The route can vanish between the policy GET and the paste (plugin
        // disposed mid-session). That race costs at most the one in-flight
        // paste; afterwards every verdict is forgotten and pastes go native.
        const harness = loadClient({
            policy: () => ({ status: 200, takeover: true }),
            postStatus: 404,
        });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const swallowed = harness.dispatchPaste(IMAGE);
        expect(swallowed.prevented).toBe(true);
        await harness.settle();
        expect(harness.insertedText()).toBe('');
        const before = harness.fetchCalls.length;
        const next = harness.dispatchPaste(IMAGE);
        expect(next.prevented).toBe(false);
        await harness.settle();
        expect(harness.fetchCalls.length).toBe(before);
    });

    it('a verdict past its hard age bound is unknown again, not reused', async () => {
        vi.useFakeTimers();
        try {
            const harness = loadClient({ policy: () => ({ status: 200, takeover: true }) });
            harness.setModelLabel('DeepSeek-V4-Flash');
            harness.focusComposer();
            await harness.settle();
            // Fresh verdict: the takeover works.
            expect(harness.dispatchPaste(IMAGE).prevented).toBe(true);
            await harness.settle();
            // 61s later the cached true is stale: the model behind this label
            // may have changed, so the paste stays native until reconfirmed.
            vi.advanceTimersByTime(61_000);
            expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a host verdict flip reaches the client within one round-trip', async () => {
        // Every focus and paste re-asks the host, so when the model behind an
        // unchanged label turns image-capable (a same-named route mounting),
        // at most the one paste racing the refresh is taken; the next goes
        // native.
        let takeover = true;
        const harness = loadClient({ policy: () => ({ status: 200, takeover }) });
        harness.setModelLabel('Shared Model');
        harness.focusComposer();
        await harness.settle();
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(true);
        await harness.settle();
        takeover = false;
        // This paste still rides the cached true (the documented round-trip
        // window) and triggers the refresh that flips it.
        harness.dispatchPaste(IMAGE);
        await harness.settle();
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
    });

    it('ignores pastes with no image files', async () => {
        const harness = loadClient({ policy: () => ({ status: 200, takeover: true }) });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const paste = harness.dispatchPaste([{ type: 'text/plain' }]);
        expect(paste.prevented).toBe(false);
    });

    it('the cordis effect removes both listeners on disposal', () => {
        const harness = loadClient({});
        expect(harness.listeners().paste).toBe(1);
        expect(harness.listeners().focusin).toBe(1);
        harness.dispose();
        expect(harness.listeners().paste).toBe(0);
        expect(harness.listeners().focusin).toBe(0);
    });
});

describe('settings card (#39)', () => {
    // The card half, loaded the same way the paste half is: the script with
    // browser globals handed in. What matters here is that it never mounts
    // where its route is off, and that pending grants survive an engine
    // switch, both found by review rather than by the browser.
    const SOURCE_TEXT = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

    it('explains comma-separated key rotation in English and Chinese', () => {
        expect(SOURCE_TEXT).toContain(
            'Separate multiple keys with commas. ModLens rotates to the next key after authentication, rate-limit, or quota failures.',
        );
        expect(SOURCE_TEXT).toContain(
            '多个密钥用英文逗号分隔。鉴权、限流或配额失败时会自动轮换到下一个密钥。',
        );
    });

    function loadCard(configStatus: number) {
        const slotRegistrations: string[] = [];
        const slotSpecs: Array<Record<string, unknown>> = [];
        const injected: string[][] = [];
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      apply: (ctx: unknown) => void;
                      __card: {
                          nextDraft: (s: unknown, p: string, r?: unknown) => unknown;
                          savePayload: (s: unknown, d: unknown) => Record<string, unknown>;
                      };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const documentStub = {
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelectorAll: () => [],
            documentElement: { lang: 'en' },
        };
        const fetchStub = (url: string) =>
            Promise.resolve({
                ok: configStatus >= 200 && configStatus < 300,
                status: url.startsWith('/modlens/config') ? configStatus : 200,
                json: () => Promise.resolve({}),
            });
        const run = new Function('window', 'document', 'fetch', 'Event', 'navigator', SOURCE_TEXT);
        run(windowStub, documentStub, fetchStub, class {}, { language: 'en' });
        if (!loaded) throw new Error('client.js never called __ModuleLoader__.load');
        const exports = loaded.factory(() => ({
            createElement: () => null,
            useState: (initial: unknown) => [initial, () => {}],
            useEffect: () => {},
            useCallback: (fn: unknown) => fn,
        }));
        exports.apply({
            effect: () => {},
            inject: (deps: string[], fn: (scope: unknown) => void) => {
                injected.push(deps);
                if (deps.includes('slots')) {
                    fn({
                        slots: {
                            inject: (_name: string, gen: () => Generator) => {
                                for (const _entry of gen()) {
                                    // consuming the generator performs the registration
                                }
                            },
                            register: (spec: { id: string }) => {
                                slotRegistrations.push(spec.id);
                                slotSpecs.push(spec as unknown as Record<string, unknown>);
                                return spec;
                            },
                        },
                    });
                }
            },
        });
        return { slotRegistrations, slotSpecs, injected, card: exports.__card };
    }

    it('does not mount where its route is off, instead of rendering an error', async () => {
        // settingsCard: false removes the host route. A card that mounted
        // anyway would show a failure where the user asked for nothing.
        const off = loadCard(404);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(off.slotRegistrations).toEqual([]);
    });

    it('mounts when the route answers', async () => {
        const on = loadCard(200);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(on.slotRegistrations).toEqual(['modlens']);
    });

    it('asks for the locale service on its own inject, not beside slots', async () => {
        // ctx.inject waits for every service it names. Naming locale in the
        // slots inject would mean no card at all on a host that ships no
        // locale service, which is the opposite of an optional dependency.
        const on = loadCard(200);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(on.injected).toContainEqual(['locale']);
        expect(on.injected).toContainEqual(['slots']);
        // And the card mounted anyway, with that inject's callback never run.
        expect(on.slotRegistrations).toEqual(['modlens']);
    });

    it('registers under the key rc.7 dispatches by and the id rc.6 lists by (#61, #65)', async () => {
        // rc.7 made settings.plugin.item a keyed slot: register throws without
        // options.key, and the card renders only when the key matches a
        // settings namespace the host serves. The host half registers that
        // namespace as 'modlens' (see dshPlugin.test.ts), so the two literals
        // must stay equal. rc.6's list slot required options.id instead, and
        // one client.js serves both, so both ride along.
        const on = loadCard(200);
        await new Promise((resolve) => setTimeout(resolve, 10));

        const spec = on.slotSpecs.find((entry) => entry.name === 'settings.plugin.item');
        expect(spec?.key).toBe('modlens');
        expect(spec?.id).toBe('modlens');
    });

    it('sends only what the save is about', async () => {
        // A reuse-only save that carried the engine fields wrote the values
        // the card loaded back over whatever the file holds now, and one that
        // carried the provider pinned an engine nobody chose.
        const { card } = loadCard(200);
        const summary = {
            provider: 'openai',
            engines: { openai: { baseUrl: 'https://a', model: 'a', hasKey: true } },
            reuse: { claude: true, codex: false, opencode: false, pi: false, grok: false },
        };
        const untouched = card.nextDraft(summary, 'openai') as Record<string, unknown> & {
            reuse: Record<string, boolean>;
        };

        // Only a grant moved: no provider, no engine, no engine fields.
        const grantOnly = card.savePayload(summary, {
            ...untouched,
            reuse: { ...untouched.reuse, pi: true },
        });
        expect(grantOnly).toEqual({ reuse: { pi: true } });

        // An edited field brings the engine with it.
        const edited = card.savePayload(summary, { ...untouched, model: 'b' });
        expect(edited).toEqual({ reuse: {}, engine: 'openai', model: 'b' });

        // Moving the select sends the pin, and unpinning sends the empty.
        const repinned = card.savePayload(summary, {
            ...(card.nextDraft(summary, '') as Record<string, unknown>),
        });
        expect(repinned.provider).toBe('');
        expect(repinned.engine).toBeUndefined();
    });

    it('keeps pending reuse grants when the engine changes', async () => {
        // The grants answer "may a read borrow this harness", which has
        // nothing to do with which engine reads the image; dropping them on
        // an engine switch silently discarded the user's answers.
        const { card } = loadCard(200);
        const summary = {
            provider: 'openai',
            engines: {
                openai: { baseUrl: 'https://a', model: 'a', hasKey: true },
                'gemini-api': { baseUrl: '', model: 'g', hasKey: false },
            },
            reuse: { claude: true, codex: false },
        };
        const pending = { claude: true, codex: true };
        const next = card.nextDraft(summary, 'gemini-api', pending) as {
            provider: string;
            model: string;
            baseUrl: string;
            apiKey: string;
            reuse: Record<string, boolean>;
        };
        expect(next.provider).toBe('gemini-api');
        expect(next.model).toBe('g');
        expect(next.baseUrl).toBe('');
        expect(next.apiKey).toBe('');
        expect(next.reuse).toEqual(pending);
        // Without a pending set it falls back to what is stored.
        expect(
            (card.nextDraft(summary, 'openai') as { reuse: Record<string, boolean> }).reuse,
        ).toEqual(summary.reuse);
    });

    it('builds a proxy draft from the mode without receiving the stored URL (#97)', async () => {
        const { card } = loadCard(200);
        const summary = {
            provider: 'openai',
            engines: {
                openai: {
                    baseUrl: 'https://gateway.example/v1',
                    model: 'm',
                    hasKey: true,
                    proxyMode: 'custom',
                },
            },
            reuse: {},
        };
        const draft = card.nextDraft(summary, 'openai') as Record<string, unknown>;
        expect(draft.proxyMode).toBe('custom');
        expect(draft.proxy).toBe('');
        expect(JSON.stringify(draft)).not.toContain('proxy.example');
    });

    it('sends proxy routing only when its mode or custom URL changes (#97)', async () => {
        const { card } = loadCard(200);
        const summary = {
            provider: 'openai',
            engines: {
                openai: {
                    baseUrl: 'https://gateway.example/v1',
                    model: 'm',
                    hasKey: true,
                    proxyMode: 'inherit',
                },
            },
            reuse: {},
        };
        const draft = card.nextDraft(summary, 'openai') as Record<string, unknown>;

        expect(card.savePayload(summary, draft)).toEqual({ reuse: {} });
        expect(card.savePayload(summary, { ...draft, proxyMode: 'direct' })).toEqual({
            reuse: {},
            engine: 'openai',
            proxyMode: 'direct',
            proxy: '',
        });
        expect(
            card.savePayload(summary, {
                ...draft,
                proxyMode: 'custom',
                proxy: 'http://127.0.0.1:7890',
            }),
        ).toEqual({
            reuse: {},
            engine: 'openai',
            proxyMode: 'custom',
            proxy: 'http://127.0.0.1:7890',
        });
        expect(
            card.savePayload(summary, {
                ...draft,
                proxyMode: 'direct',
                proxy: 'http://proxy-user:proxy-pass@127.0.0.1:7890',
            }),
        ).toEqual({
            reuse: {},
            engine: 'openai',
            proxyMode: 'direct',
            proxy: '',
        });
    });
});

describe('the API key field is masked without being a password field (#56)', () => {
    // Safari's iCloud Keychain offers to enable autofill for any site with a
    // password input, then pops its bubble on every focus, for a field that
    // is always empty here: the key lives in the config file and the host
    // sends only whether one is stored. autocomplete cannot turn that off,
    // because WebKit ignores it on password fields on purpose.
    const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

    function secretProps(css: unknown): Record<string, unknown> {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __card: { secretFieldProps: () => Record<string, unknown> };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const documentStub = {
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelectorAll: () => [],
            documentElement: { lang: 'en' },
        };
        new Function('window', 'document', 'CSS', 'fetch', SOURCE)(
            windowStub,
            documentStub,
            css,
            () => Promise.resolve(),
        );
        const card = (loaded as NonNullable<typeof loaded>).factory(() => ({})).__card;
        return card.secretFieldProps();
    }

    it('masks with text-security where the browser supports it', () => {
        const props = secretProps({ supports: (name: string) => name === '-webkit-text-security' });
        expect(props.type).toBe('text');
        expect((props.style as Record<string, unknown>).WebkitTextSecurity).toBe('disc');
        expect(props.autoComplete).toBe('off');
    });

    it('falls back to a password field rather than showing the key', () => {
        // The nuisance is worth more than the alternative, which is somebody's
        // API key in clear text while they type it.
        expect(secretProps({ supports: () => false }).type).toBe('password');
        expect(secretProps(undefined).type).toBe('password');
    });
});

describe('the rendered API key field, not just the helper (#56)', () => {
    // The previous version of these tests only exercised the props helper.
    // An independent review mutated the call site to ask for a plain text
    // field, and every test stayed green while the key rendered in clear
    // text. What has to be pinned is the field the card actually builds.
    const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

    /** Every element the card built, flattened, with its props. */
    function renderCard(css: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __card: { ConfigCard: (react: unknown, ui: unknown) => () => unknown };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const documentStub = {
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelectorAll: () => [],
            documentElement: { lang: 'en' },
        };
        new Function('window', 'document', 'CSS', 'fetch', SOURCE)(
            windowStub,
            documentStub,
            css,
            () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        );

        const built: Array<{ type: unknown; props: Record<string, unknown> }> = [];
        // A state stub that hands back what the card needs to reach the
        // engine fields: expanded, with a summary and a draft naming openai.
        const summary = {
            provider: 'openai',
            engines: { openai: { baseUrl: '', model: '', hasKey: true, source: 'file' } },
            keyless: [],
            reuse: {},
        };
        const draft = { provider: 'openai', apiKey: '', baseUrl: '', model: '', reuse: {} };
        const states = [true, summary, draft, ''];
        let index = 0;
        const react = {
            createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
                built.push({ type, props: props ?? {} });
                return { type, props, kids };
            },
            useState: () => [states[index++ % states.length], () => {}],
            useEffect: () => {},
            useCallback: (fn: unknown) => fn,
        };
        const Input = function Input() {
            return null;
        };
        const Card = (loaded as NonNullable<typeof loaded>)
            .factory(() => ({}))
            .__card.ConfigCard(react, { Input });
        Card();
        return built.filter((node) => node.type === Input);
    }

    function apiKeyField(css: unknown): Record<string, unknown> | undefined {
        // The key field is the one whose placeholder is the stored-key hint.
        return renderCard(css).find((node) =>
            String(node.props.placeholder ?? '').match(/留空|leave empty/),
        )?.props;
    }

    it('renders masked rather than as a password field', () => {
        const props = apiKeyField({ supports: () => true });
        expect(props).toBeDefined();
        expect(props?.type).toBe('text');
        expect((props?.style as Record<string, unknown> | undefined)?.WebkitTextSecurity).toBe(
            'disc',
        );
    });

    it('renders a password field where masking is unavailable', () => {
        expect(apiKeyField({ supports: () => false })?.type).toBe('password');
    });

    it('never renders the key field as a plain visible input', () => {
        for (const css of [{ supports: () => true }, { supports: () => false }, undefined]) {
            const props = apiKeyField(css);
            const masked =
                props?.type === 'password' ||
                (props?.style as Record<string, unknown> | undefined)?.WebkitTextSecurity ===
                    'disc';
            expect(masked).toBe(true);
        }
    });
});

describe('a failed load or save speaks the reader’s language', () => {
    // The footer note lands in a role="status" region, so it is read aloud.
    // The two failure paths used to hard-code English fallbacks, which put
    // "load failed" under a Chinese card. What the server said still travels
    // untranslated: that is the diagnosis, not the card's copy.
    const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

    interface Node {
        type: unknown;
        props: Record<string, unknown>;
        kids: unknown[];
    }

    /** Render the card once, with the given states and a failing route. */
    function render(options: { lang: string; states: unknown[]; detail?: string }): {
        notes: string[];
        nodes: Node[];
    } {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __card: { ConfigCard: (react: unknown, ui: unknown) => () => unknown };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const documentStub = {
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelectorAll: () => [],
            documentElement: { lang: options.lang },
        };
        // Every /modlens/config request fails; the body carries a server
        // detail only where the test asked for one.
        const fetchStub = () =>
            Promise.resolve({
                ok: false,
                status: 500,
                json: () => Promise.resolve(options.detail ? { error: options.detail } : {}),
            });
        new Function('window', 'document', 'CSS', 'fetch', 'navigator', SOURCE)(
            windowStub,
            documentStub,
            undefined,
            fetchStub,
            { language: options.lang },
        );

        // The note is the fourth useState in the card, after open, summary
        // and draft; only its setter is worth recording.
        const notes: string[] = [];
        const nodes: Node[] = [];
        let index = 0;
        const react = {
            createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
                const node = { type, props: props ?? {}, kids };
                nodes.push(node);
                return node;
            },
            useState: () => {
                const slot = index++;
                return [
                    options.states[slot],
                    (value: unknown) => {
                        if (slot === 3) notes.push(String(value));
                    },
                ];
            },
            useEffect: (fn: () => void) => {
                fn();
            },
            useCallback: (fn: unknown) => fn,
        };
        const Input = function Input() {
            return null;
        };
        const Card = (loaded as NonNullable<typeof loaded>)
            .factory(() => ({}))
            .__card.ConfigCard(react, { Input });
        Card();
        return { notes, nodes };
    }

    /** A drained microtask queue: the card's fetch chains are promise-only. */
    async function settle(): Promise<void> {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    // Expanded with nothing loaded yet: the effect fires the load, which fails.
    const loadStates = (): unknown[] => [true, null, null, ''];

    // Expanded with a summary whose draft was edited, so save is enabled.
    const saveStates = (): unknown[] => [
        true,
        {
            provider: 'openai',
            engines: { openai: { baseUrl: 'https://a', model: 'a', hasKey: true } },
            keyless: [],
            reuse: {},
        },
        { provider: 'openai', apiKey: '', baseUrl: 'https://a', model: 'b', reuse: {} },
        '',
    ];

    function clickSave(nodes: Node[], label: string): void {
        const button = nodes.find((node) => node.type === 'button' && node.kids.includes(label));
        if (!button) throw new Error(`no save button labelled ${label}`);
        (button.props.onClick as () => void)();
    }

    it('falls back to a localized line when the server said nothing', async () => {
        const zh = render({ lang: 'zh-CN', states: loadStates() });
        await settle();
        expect(zh.notes).toEqual(['加载失败']);

        const en = render({ lang: 'en', states: loadStates() });
        await settle();
        expect(en.notes).toEqual(['load failed']);
    });

    it('says so in the reader’s language when a save fails', async () => {
        const zh = render({ lang: 'zh-CN', states: saveStates() });
        clickSave(zh.nodes, '保存');
        await settle();
        expect(zh.notes).toEqual(['保存中…', '保存失败']);

        const en = render({ lang: 'en', states: saveStates() });
        clickSave(en.nodes, 'Save');
        await settle();
        expect(en.notes).toEqual(['saving...', 'save failed']);
    });

    it('shows what the server said rather than translating it', async () => {
        // 'unknown engine: x' and path errors are the diagnosis. Mapping them
        // to error codes would buy a translation table for a dozen strings.
        const zh = render({ lang: 'zh-CN', states: loadStates(), detail: 'unknown engine: x' });
        await settle();
        expect(zh.notes).toEqual(['unknown engine: x']);
    });
});

describe('the card follows dsh’s own interface language', () => {
    // dsh 0.1.0-rc.7 ships `<html lang="zh-CN">` frozen into the built
    // index.html and never rewrites it, so a user whose dsh is set to English
    // still got a Chinese card. The locale service knows the real answer, so
    // it is asked first and the page language is only the fallback.
    const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

    /** A stand-in for dsh's LocaleRuntime, read side plus a switch. */
    class FakeLocale {
        private snapshot: { active: string; locales: unknown[]; revision: number };
        private readonly listeners = new Set<() => void>();
        public subscribeCalls = 0;

        constructor(active: string) {
            this.snapshot = { active, locales: [], revision: 1 };
        }

        getSnapshot(): { active: string; locales: unknown[]; revision: number } {
            return this.snapshot;
        }

        getLocale(): { active: string; locales: unknown[]; revision: number } {
            return this.snapshot;
        }

        subscribe(fn: () => void): () => void {
            this.subscribeCalls += 1;
            this.listeners.add(fn);
            return () => this.listeners.delete(fn);
        }

        setLocale(active: string): void {
            this.snapshot = { active, locales: [], revision: this.snapshot.revision + 1 };
            for (const fn of this.listeners) fn();
        }
    }

    interface Mounted {
        /** Every string child the latest render produced. */
        texts: string[];
        /** How many times the card re-rendered after the first. */
        renders: number;
    }

    /**
     * Render the collapsed card once and keep re-rendering it the way React
     * would: whatever useSyncExternalStore subscribed with is the re-render.
     */
    function mount(options: { lang: string; locale?: FakeLocale }): Mounted {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __card: {
                          ConfigCard: (
                              react: unknown,
                              ui: unknown,
                              localeRef?: unknown,
                          ) => () => unknown;
                      };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const documentStub = {
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelectorAll: () => [],
            documentElement: { lang: options.lang },
        };
        new Function('window', 'document', 'CSS', 'fetch', 'navigator', SOURCE)(
            windowStub,
            documentStub,
            undefined,
            () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
            { language: options.lang },
        );

        const state: Mounted = { texts: [], renders: 0 };
        let subscribed = false;
        const react = {
            createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
                for (const kid of kids) if (typeof kid === 'string') state.texts.push(kid);
                return { type, props: props ?? {}, kids };
            },
            useState: (initial: unknown) => [initial, () => {}],
            useEffect: () => {},
            useCallback: (fn: unknown) => fn,
            useSyncExternalStore: (
                subscribe: (onChange: () => void) => () => void,
                getSnapshot: () => unknown,
            ) => {
                // React subscribes once per mount and re-renders on notice.
                if (!subscribed) {
                    subscribed = true;
                    subscribe(() => {
                        state.renders += 1;
                        state.texts = [];
                        Card();
                    });
                }
                return getSnapshot();
            },
        };
        const Input = function Input() {
            return null;
        };
        const Card = (loaded as NonNullable<typeof loaded>)
            .factory(() => ({}))
            .__card.ConfigCard(
                react,
                { Input },
                options.locale ? { current: options.locale } : undefined,
            );
        Card();
        return state;
    }

    const ZH_TITLE = '视觉引擎（ModLens）';
    const EN_TITLE = 'Vision engine (ModLens)';

    it('speaks English where dsh is set to English under a zh-CN page', () => {
        // The reported bug: locale.preference: en, but <html lang="zh-CN">.
        const card = mount({ lang: 'zh-CN', locale: new FakeLocale('en') });
        expect(card.texts).toContain(EN_TITLE);
        expect(card.texts).not.toContain(ZH_TITLE);
    });

    it('speaks Chinese where dsh is set to Chinese under an English page', () => {
        const card = mount({ lang: 'en-US', locale: new FakeLocale('zh') });
        expect(card.texts).toContain(ZH_TITLE);
        expect(card.texts).not.toContain(EN_TITLE);
    });

    it('falls back to the page language where the host serves no locale service', () => {
        // Older dsh and every non-web profile: nothing to ask, so the old
        // chain stands unchanged.
        expect(mount({ lang: 'zh-CN' }).texts).toContain(ZH_TITLE);
        expect(mount({ lang: 'en-US' }).texts).toContain(EN_TITLE);
    });

    it('switches copy when the user switches language mid-session', () => {
        const locale = new FakeLocale('zh');
        const card = mount({ lang: 'zh-CN', locale });
        expect(card.texts).toContain(ZH_TITLE);
        expect(locale.subscribeCalls).toBe(1);

        locale.setLocale('en');
        expect(card.renders).toBe(1);
        expect(card.texts).toContain(EN_TITLE);
        expect(card.texts).not.toContain(ZH_TITLE);
    });
});

describe('settings card progressive discovery (#83)', () => {
    // Expanding used to wait on `doctor --json` before any field appeared.
    // The form is the config GET. The auto-mode section is a later probe.
    const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

    const CONFIG = {
        provider: 'openai',
        engines: {
            openai: {
                baseUrl: '',
                model: '',
                hasKey: true,
                source: 'file',
                proxyMode: 'inherit',
            },
        },
        keyless: [] as string[],
        reuse: { claude: false, codex: false, opencode: false, pi: false, grok: false },
    };

    const CLAUDE_PROBE = {
        harness: 'claude',
        cliFound: true,
        loggedIn: true,
        cliPath: '/usr/bin/claude',
    };

    interface Node {
        type: unknown;
        props: Record<string, unknown>;
        kids: unknown[];
    }

    interface Progressive {
        texts: () => string[];
        expand: () => void;
        collapse: () => void;
        changeProvider: (provider: string) => void;
        changeProxyMode: (mode: string) => void;
        setCustomProxy: (url: string) => void;
        save: () => void;
        fetchCalls: FetchCall[];
        selectedProvider: () => string;
        selectedProxyMode: () => string;
        buttonDisabled: (label: string) => boolean;
        resolveConfig: (request: number, body: unknown) => void;
        resolveDiscover: (body: unknown) => void;
        resolveSave: (body: unknown) => void;
    }

    function depsEqual(left?: unknown[], right?: unknown[]): boolean {
        if (left === right) return true;
        if (!left || !right || left.length !== right.length) return false;
        return left.every((item, index) => Object.is(item, right[index]));
    }

    function walk(node: unknown, visit: (el: Node) => void): void {
        if (node == null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const child of node) walk(child, visit);
            return;
        }
        const el = node as Node;
        visit(el);
        walk(el.kids, visit);
    }

    function textsOf(root: unknown): string[] {
        const texts: string[] = [];
        const take = (node: unknown): void => {
            if (node == null || node === false) return;
            if (typeof node === 'string') {
                texts.push(node);
                return;
            }
            if (typeof node === 'number') {
                texts.push(String(node));
                return;
            }
            if (Array.isArray(node)) {
                for (const child of node) take(child);
                return;
            }
            if (typeof node === 'object' && node !== null && 'kids' in node) {
                take((node as Node).kids);
            }
        };
        take(root);
        return texts;
    }

    function findToggle(root: unknown): Node | undefined {
        let found: Node | undefined;
        walk(root, (el) => {
            if (found) return;
            if (el.type === 'button' && el.props && 'aria-expanded' in el.props) found = el;
        });
        return found;
    }

    async function flush(): Promise<void> {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    function mount(options: { deferConfig?: boolean; deferSave?: boolean } = {}): Progressive {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __card: { ConfigCard: (react: unknown, ui: unknown) => () => unknown };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const documentStub = {
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelectorAll: () => [],
            documentElement: { lang: 'en' },
        };

        const fetchCalls: FetchCall[] = [];
        let resolveDiscover!: (body: unknown) => void;
        const discover = new Promise<unknown>((resolve) => {
            resolveDiscover = resolve;
        });
        let resolveSave!: (body: unknown) => void;
        const save = new Promise<unknown>((resolve) => {
            resolveSave = resolve;
        });
        const configResolvers: Array<(body: unknown) => void> = [];

        const fetchStub = (url: string, init?: { method?: string; body?: unknown }) => {
            fetchCalls.push({ url, init });
            if (init?.method === 'POST') {
                const body = options.deferSave ? save : Promise.resolve({ ...CONFIG });
                return body.then((next) => ({
                    ok: true,
                    json: () => Promise.resolve(next),
                }));
            }
            if (String(url).includes('discover=')) {
                return discover.then((body) => ({
                    ok: true,
                    json: () => Promise.resolve(body),
                }));
            }
            const body = options.deferConfig
                ? new Promise<unknown>((resolve) => configResolvers.push(resolve))
                : Promise.resolve({ ...CONFIG });
            return body.then((next) => ({
                ok: true,
                json: () => Promise.resolve(next),
            }));
        };

        new Function('window', 'document', 'CSS', 'fetch', 'navigator', SOURCE)(
            windowStub,
            documentStub,
            undefined,
            fetchStub,
            { language: 'en' },
        );

        type Hook = { value: unknown; deps?: unknown[] };
        const hooks: Hook[] = [];
        let hookIndex = 0;
        const pendingEffects: Array<{ index: number; fn: () => void; deps?: unknown[] }> = [];
        let root: unknown;
        let Card: () => unknown;

        const rerender = () => {
            hookIndex = 0;
            pendingEffects.length = 0;
            root = Card();
            const scheduled = pendingEffects.slice();
            pendingEffects.length = 0;
            for (const effect of scheduled) {
                const prev = hooks[effect.index];
                const changed = !prev || !depsEqual(prev.deps, effect.deps);
                hooks[effect.index] = { value: undefined, deps: effect.deps };
                if (changed) effect.fn();
            }
        };

        const react = {
            createElement: (type: unknown, props: Record<string, unknown>, ...kids: unknown[]) => {
                const node: Node = { type, props: props ?? {}, kids };
                return node;
            },
            useState: (initial: unknown) => {
                const index = hookIndex++;
                if (hooks[index] === undefined) hooks[index] = { value: initial };
                const setState = (update: unknown) => {
                    const prev = hooks[index].value;
                    hooks[index].value =
                        typeof update === 'function'
                            ? (update as (p: unknown) => unknown)(prev)
                            : update;
                    rerender();
                };
                return [hooks[index].value, setState];
            },
            useCallback: (fn: unknown, deps?: unknown[]) => {
                const index = hookIndex++;
                const prev = hooks[index];
                if (prev && depsEqual(prev.deps, deps)) return prev.value;
                hooks[index] = { value: fn, deps };
                return fn;
            },
            useEffect: (fn: () => void, deps?: unknown[]) => {
                const index = hookIndex++;
                pendingEffects.push({ index, fn, deps });
            },
        };

        const Input = function Input() {
            return null;
        };
        Card = (loaded as NonNullable<typeof loaded>)
            .factory(() => ({}))
            .__card.ConfigCard(react, {
                Input,
            });
        rerender();

        const clickToggle = () => {
            const button = findToggle(root);
            if (!button) throw new Error('no expand/collapse button');
            (button.props.onClick as () => void)();
        };
        const find = (predicate: (node: Node) => boolean, message: string): Node => {
            let found: Node | undefined;
            walk(root, (node) => {
                if (!found && predicate(node)) found = node;
            });
            if (!found) throw new Error(message);
            return found;
        };

        return {
            texts: () => textsOf(root),
            expand: clickToggle,
            collapse: clickToggle,
            changeProvider: (provider: string) => {
                const select = find((node) => node.type === 'select', 'no engine select');
                (select.props.onChange as (event: unknown) => void)({
                    target: { value: provider },
                });
            },
            changeProxyMode: (mode: string) => {
                const select = find(
                    (node) => node.type === 'select' && node.props.name === 'proxyMode',
                    'no proxy mode select',
                );
                (select.props.onChange as (event: unknown) => void)({
                    target: { value: mode },
                });
            },
            setCustomProxy: (url: string) => {
                const input = find(
                    (node) =>
                        node.type === Input &&
                        String(node.props.placeholder ?? '').includes('127.0.0.1'),
                    'no custom proxy input',
                );
                (input.props.onChange as (event: unknown) => void)({ target: { value: url } });
            },
            save: () => {
                const button = find(
                    (node) => node.type === 'button' && textsOf(node.kids).includes('Save'),
                    'no save button',
                );
                (button.props.onClick as () => void)();
            },
            fetchCalls,
            selectedProvider: () => {
                const select = find((node) => node.type === 'select', 'no engine select');
                return String(select.props.value);
            },
            selectedProxyMode: () => {
                const select = find(
                    (node) => node.type === 'select' && node.props.name === 'proxyMode',
                    'no proxy mode select',
                );
                return String(select.props.value);
            },
            buttonDisabled: (label: string) => {
                const button = find(
                    (node) => node.type === 'button' && textsOf(node.kids).includes(label),
                    `no ${label} button`,
                );
                return Boolean(button.props.disabled);
            },
            resolveConfig: (request: number, body: unknown) => {
                const resolve = configResolvers[request];
                if (!resolve) throw new Error(`no config request ${request}`);
                resolve(body);
            },
            resolveDiscover: (body: unknown) => resolveDiscover(body),
            resolveSave: (body: unknown) => resolveSave(body),
        };
    }

    it('renders the engine form while local-agent discovery is still in flight', async () => {
        const card = mount();
        card.expand();
        await flush();

        expect(card.fetchCalls.map((call) => call.url)).toEqual([
            '/modlens/config',
            '/modlens/config?discover=1',
        ]);

        const texts = card.texts();
        expect(texts).toContain('Engine');
        expect(texts).toContain('API key');
        expect(texts).toContain('Model');
        expect(texts).toContain('Save');
        expect(texts).toContain('loading...');
        expect(texts).not.toContain('claude');
        expect(texts).not.toContain('codex');
    });

    it('lets an API provider bypass inherited proxies and posts that choice (#97)', async () => {
        const card = mount();
        card.expand();
        await flush();

        expect(card.selectedProxyMode()).toBe('inherit');
        card.changeProxyMode('direct');
        expect(card.selectedProxyMode()).toBe('direct');
        card.save();
        await flush();

        const post = card.fetchCalls.find((call) => call.init?.method === 'POST');
        expect(JSON.parse(String(post?.init?.body))).toMatchObject({
            engine: 'openai',
            proxyMode: 'direct',
        });
    });

    it('accepts a provider-specific proxy URL from the settings card (#97)', async () => {
        const card = mount();
        card.expand();
        await flush();

        card.changeProxyMode('custom');
        card.setCustomProxy('http://proxy-user:proxy-pass@127.0.0.1:7890');
        card.save();
        await flush();

        const post = card.fetchCalls.find((call) => call.init?.method === 'POST');
        expect(JSON.parse(String(post?.init?.body))).toMatchObject({
            engine: 'openai',
            proxyMode: 'custom',
            proxy: 'http://proxy-user:proxy-pass@127.0.0.1:7890',
        });
    });

    it('requires a URL for a new custom route without trapping the discard action (#97)', async () => {
        const card = mount();
        card.expand();
        await flush();

        card.changeProxyMode('custom');
        expect(card.buttonDisabled('Save')).toBe(true);
        expect(card.buttonDisabled('Discard')).toBe(false);
    });

    it('fills the auto-mode section once discovery returns, without hiding the form', async () => {
        const card = mount();
        card.expand();
        await flush();

        card.resolveDiscover({
            ...CONFIG,
            discovery: [CLAUDE_PROBE],
        });
        await flush();

        const texts = card.texts();
        expect(texts).toContain('Engine');
        expect(texts).toContain('API key');
        expect(texts).toContain('Model');
        expect(texts).toContain('Save');
        expect(texts).toContain('claude');
        expect(texts).not.toContain('codex');
        expect(texts).not.toContain('loading...');
    });

    it('falls back to the full grant list when discovery returns null', async () => {
        const card = mount();
        card.expand();
        await flush();

        card.resolveDiscover({
            ...CONFIG,
            discovery: null,
        });
        await flush();

        expect(card.texts()).toEqual(
            expect.arrayContaining(['claude', 'codex', 'opencode', 'pi', 'grok']),
        );
        expect(card.texts()).not.toContain('loading...');
    });

    it('ignores an older config load that lands after collapse and reopen', async () => {
        const card = mount({ deferConfig: true });
        card.expand();
        await flush();
        card.collapse();
        card.resolveConfig(0, { ...CONFIG, provider: '' });
        await flush();
        card.expand();
        await flush();

        expect(card.fetchCalls.filter((call) => call.url === '/modlens/config')).toHaveLength(2);
        card.resolveConfig(1, { ...CONFIG });
        await flush();
        expect(card.selectedProvider()).toBe('openai');
        expect(
            card.fetchCalls.filter((call) => call.url === '/modlens/config?discover=1'),
        ).toHaveLength(1);
    });

    it('keeps discovery that lands while an earlier save is still in flight', async () => {
        const card = mount({ deferSave: true });
        card.expand();
        await flush();

        card.changeProvider('');
        card.save();
        await flush();

        card.resolveDiscover({
            ...CONFIG,
            discovery: [CLAUDE_PROBE],
        });
        await flush();
        expect(card.texts()).toContain('claude');
        expect(card.texts()).not.toContain('codex');

        card.resolveSave({ ...CONFIG });
        await flush();

        expect(card.texts()).toContain('saved');
        expect(card.texts()).toContain('claude');
        expect(card.texts()).not.toContain('codex');
    });

    it('keeps an in-flight discovery across collapse and reopen without probing twice', async () => {
        const card = mount();
        card.expand();
        await flush();
        card.changeProvider('');
        card.collapse();
        card.expand();
        await flush();
        expect(card.selectedProvider()).toBe('');

        card.resolveDiscover({
            ...CONFIG,
            discovery: [CLAUDE_PROBE],
        });
        await flush();

        const texts = card.texts();
        expect(texts).toContain('claude');
        expect(texts).not.toContain('codex');
        expect(texts).not.toContain('loading...');
        expect(card.selectedProvider()).toBe('');
        expect(card.fetchCalls.map((call) => call.url)).toEqual([
            '/modlens/config',
            '/modlens/config?discover=1',
        ]);
    });
});
