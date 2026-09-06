import { describe, expect, it, vi } from 'vitest';

describe('dsh model scope', () => {
    type Model = {
        provider?: string;
        id: string;
        name?: string;
        inputModalities?: string[];
    };

    async function load(
        catalogs: Record<string, Model[]>,
        config: Record<string, unknown> = { families: ['*'] },
    ) {
        // @ts-expect-error The shipped DSH plugin is intentionally plain JavaScript.
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: Array<{
            providers: string[];
            adapter: Record<string, CallableFunction>;
        }> = [];
        const handlers: Record<string, () => void> = {};
        const probes: string[] = [];
        const llm = {
            listProviders: () => Object.keys(catalogs).map((id) => ({ id, name: `Route ${id}` })),
            listModels: async (provider: string) => {
                probes.push(provider);
                return catalogs[provider] ?? [];
            },
            resolveModelInfo: async (provider: string, model: string) => {
                const found = catalogs[provider]?.find(({ id }) => id === model);
                return found ? { ...found } : { id: model };
            },
            providerRetryPolicy: () => undefined,
            stream: () => (async function* () {})(),
            registerAdapter: (providers: string[], adapter: Record<string, CallableFunction>) => {
                registered.push({ providers, adapter });
                adapter.providerInfo(providers[0]);
                const dispose = () => {};
                dispose.replace = () => {};
                return dispose;
            },
        };

        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, handler: () => void) => {
                    handlers[event] = handler;
                },
                llm,
            } as never,
            { pasteToPath: false, settingsCard: false, ...config },
        );

        return { registered, handlers, probes };
    }

    it('discovers an arbitrary text-only model when wildcard families are enabled', async () => {
        const { registered } = await load({
            'community-route': [
                {
                    provider: 'community-route',
                    id: 'nova-1',
                    name: 'Nova 1',
                    inputModalities: ['text'],
                },
            ],
        });

        await vi.waitFor(() => expect(registered).toHaveLength(1));
        expect(registered[0].providers).toEqual(['modlens-community-route']);

        const models = (await registered[0].adapter.listModels(
            'modlens-community-route',
        )) as Array<{ id: string; provider: string; inputModalities: string[] }>;
        expect(models).toEqual([
            expect.objectContaining({
                id: 'nova-1',
                provider: 'modlens-community-route',
                inputModalities: ['text', 'image'],
            }),
        ]);
    });

    it.each([
        ['missing capability metadata', { id: 'nova-unknown' }],
        ['an empty capability list', { id: 'nova-empty', inputModalities: [] }],
        ['capabilities without text', { id: 'nova-audio', inputModalities: ['audio'] }],
        ['native image input', { id: 'nova-native', inputModalities: ['text', 'image'] }],
        ['a visual model id', { id: 'nova-vision-pro', inputModalities: ['text'] }],
        ['a non-pro MiMo model', { id: 'mimo-v2-omni', inputModalities: ['text'] }],
    ])('does not wildcard-wrap %s', async (_label, model) => {
        const { registered, probes } = await load({ route: [model] });
        await vi.waitFor(() => expect(probes).toContain('route'));
        expect(registered).toEqual([]);
    });

    it('keeps the default family scope while discovering third-party DeepSeek routes', async () => {
        const { registered } = await load(
            {
                'ark-deepseek': [{ id: 'deepseek-v4-pro', inputModalities: ['text'] }],
                community: [{ id: 'nova-1', inputModalities: ['text'] }],
            },
            {},
        );

        await vi.waitFor(() => expect(registered).toHaveLength(1));
        expect(registered[0].providers).toEqual(['modlens-ark-deepseek']);
    });

    it('keeps explicit family prefixes compatible with unknown capability metadata', async () => {
        const { registered } = await load(
            { community: [{ id: 'nova-1' }] },
            { families: ['nova'] },
        );

        await vi.waitFor(() => expect(registered).toHaveLength(1));
        expect(registered[0].providers).toEqual(['modlens-community']);
    });

    it('keeps discovery limited to configured upstream routes', async () => {
        const { registered, probes } = await load(
            {
                selected: [{ id: 'nova-1', inputModalities: ['text'] }],
                excluded: [{ id: 'nova-2', inputModalities: ['text'] }],
            },
            { families: ['*'], discover: ['selected'] },
        );

        await vi.waitFor(() => expect(registered).toHaveLength(1));
        expect(registered[0].providers).toEqual(['modlens-selected']);
        expect(probes).not.toContain('excluded');
    });

    it('rechecks wildcard eligibility when listing and resolving a formerly text-only model', async () => {
        const model: Model = { id: 'nova-1', inputModalities: ['text'] };
        const { registered } = await load({ community: [model] });
        await vi.waitFor(() => expect(registered).toHaveLength(1));
        const adapter = registered[0].adapter;

        model.inputModalities = ['text', 'image'];

        await expect(adapter.listModels('modlens-community')).resolves.toEqual([]);
        await expect(adapter.resolveModel('modlens-community', 'nova-1')).rejects.toThrow(
            'declares native image input',
        );
    });
});
