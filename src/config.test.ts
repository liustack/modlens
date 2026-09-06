import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    assertNoRetiredEndpointBinding,
    assertReadableConfig,
    CONFIG_TEMPLATE,
    defaultProviderName,
    initConfigFile,
    loadConfigFile,
    providerConfiguredInFile,
    REUSE_HARNESSES,
    renderEffectiveConfig,
    resolveProviderSettings,
    saveProviderBundle,
    setConfigValue,
    useProviderBundle,
} from './config.ts';
import { listProviders } from './providers/index.ts';
import { splitApiKeys } from './util/apiKeys.ts';

describe('defaultProviderName', () => {
    it('falls back to antigravity-cli without config', () => {
        expect(defaultProviderName({})).toBe('antigravity-cli');
        expect(defaultProviderName({ provider: '  ' })).toBe('antigravity-cli');
    });

    it('honors an explicit provider', () => {
        expect(defaultProviderName({ provider: 'gemini-api' })).toBe('gemini-api');
    });
});

describe('resolveProviderSettings', () => {
    it('takes credentials from the file and nowhere else (#42)', () => {
        // These bindings existed and were removed: an ambient key silently
        // replacing a configured one is a 401 with nothing in it naming the
        // environment as the source.
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { 'gemini-api': { apiKey: 'from-file', model: 'm1' } } },
            { GEMINI_API_KEY: 'from-env' },
        );
        expect(settings.apiKey).toBe('from-file');
        expect(settings.model).toBe('m1');
    });

    it('uses the environment whole for a provider the file never mentions', () => {
        const settings = resolveProviderSettings(
            'openai',
            {},
            { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://gw.example.com/v1' },
        );
        expect(settings.baseUrl).toBe('https://gw.example.com/v1');
        expect(settings.apiKey).toBe('k');
    });

    it('keeps an explicit empty provider proxy as direct instead of inheriting the global proxy (#97)', () => {
        const settings = resolveProviderSettings(
            'openai',
            {
                proxy: 'http://127.0.0.1:7890',
                providers: { openai: { apiKey: 'k', proxy: '' } },
            },
            {},
        );
        expect(settings.proxy).toBe('');
    });
});

describe('setConfigValue + loadConfigFile + renderEffectiveConfig', () => {
    it('round-trips dotted keys and masks keys on render', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('provider', 'gemini-api', file);
        setConfigValue('gemini-api.apiKey', 'AIzaSecretSecret123', file);
        const loaded = loadConfigFile(file);
        expect(loaded.provider).toBe('gemini-api');
        expect(loaded.providers?.['gemini-api']?.apiKey).toBe('AIzaSecretSecret123');
        expect(renderEffectiveConfig(loaded, {})).not.toContain('SecretSecret');
        expect(() => setConfigValue('gemini-api.password', 'x', file)).toThrow(
            'Unknown config field',
        );
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('shows the file values, and never invents one from the environment', () => {
        const rendered = renderEffectiveConfig(
            {
                provider: 'gemini-api',
                providers: { 'gemini-api': { model: 'm1', apiKey: 'AIzaFromFile12345' } },
            },
            { GEMINI_API_KEY: 'AIzaFromEnv12345' },
        );
        const parsed = JSON.parse(rendered) as {
            provider?: string;
            providers: Record<string, Record<string, string>>;
        };
        expect(parsed.provider).toBe('gemini-api');
        // The key is the file's, masked, and tagged file; the ambient one is
        // not shown, because it is not used.
        expect(parsed.providers['gemini-api'].apiKey).toMatch(/\(file\)$/);
        expect(parsed.providers['gemini-api'].apiKey).not.toContain('FromFile');
        expect(rendered).not.toContain('FromEnv');
        // model came from the file, tagged file.
        expect(parsed.providers['gemini-api'].model).toBe('m1 (file)');
    });

    it('masks proxy credentials everywhere config show renders them', () => {
        // config show output is written to be pasted into issues; a proxy
        // URL's userinfo is a credential exactly like an apiKey.
        const fromFile = JSON.parse(
            renderEffectiveConfig(
                {
                    proxy: 'http://alice:s3cr3t@proxy.example:8080',
                    providers: { openai: { proxy: 'socks5://bob:hunter2@10.0.0.1:1080' } },
                },
                {},
            ),
        ) as { proxy?: string; providers: Record<string, Record<string, string>> };
        expect(fromFile.proxy).toBe('http://***@proxy.example:8080/ (file)');
        expect(fromFile.providers.openai.proxy).toBe('socks5://***@10.0.0.1:1080 (file)');
        expect(JSON.stringify(fromFile)).not.toContain('s3cr3t');
        expect(JSON.stringify(fromFile)).not.toContain('hunter2');

        const fromEnv = JSON.parse(
            renderEffectiveConfig({}, { HTTPS_PROXY: 'http://carol:t0ps3cret@proxy.example:8080' }),
        ) as { proxy?: string };
        expect(fromEnv.proxy).toBe('http://***@proxy.example:8080/ (env)');

        // A proxy without credentials renders untouched.
        const plain = JSON.parse(
            renderEffectiveConfig({ proxy: 'http://proxy.example:8080' }, {}),
        ) as { proxy?: string };
        expect(plain.proxy).toBe('http://proxy.example:8080 (file)');
    });

    it('renders an explicit empty provider proxy as direct instead of a blank value (#97)', () => {
        const shown = JSON.parse(
            renderEffectiveConfig(
                {
                    proxy: 'http://proxy.example:8080',
                    providers: { openai: { apiKey: 'k', proxy: '' } },
                },
                { HTTPS_PROXY: 'http://env-proxy.example:8080' },
            ),
        ) as { providers: Record<string, Record<string, string>> };
        expect(shown.providers.openai.proxy).toBe('direct (file)');
    });

    it('stores extraBody as parsed JSON, clears it on an empty value, and shows it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('openai.extraBody', '{"thinking":{"type":"disabled"}}', file);
        // An object, not the string: the provider merges it into the request body.
        expect(loadConfigFile(file).providers?.openai?.extraBody).toEqual({
            thinking: { type: 'disabled' },
        });
        const rendered = JSON.parse(renderEffectiveConfig(loadConfigFile(file), {})) as {
            providers: Record<string, Record<string, string>>;
        };
        expect(rendered.providers.openai.extraBody).toBe('{"thinking":{"type":"disabled"}} (file)');
        expect(() => setConfigValue('openai.extraBody', '{oops', file)).toThrow(
            'openai.extraBody is not valid JSON',
        );
        setConfigValue('openai.extraBody', '', file);
        expect(loadConfigFile(file).providers?.openai?.extraBody).toBeUndefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects malformed json with a fix hint', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, '{broken');
        expect(() => loadConfigFile(file)).toThrow('Fix or delete the file');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('guards config', () => {
    it('round-trips guards.denyModels from a JSON array or a comma list', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('guards.denyModels', '["gemini-3*", "gpt-5.6*"]', file);
        expect(loadConfigFile(file).guards?.denyModels).toEqual(['gemini-3*', 'gpt-5.6*']);
        setConfigValue('guards.denyModels', 'claude-*, qwen-vl-*', file);
        expect(loadConfigFile(file).guards?.denyModels).toEqual(['claude-*', 'qwen-vl-*']);
        // An empty value clears the list without hand-editing the file.
        setConfigValue('guards.denyModels', '', file);
        expect(loadConfigFile(file).guards?.denyModels).toBeUndefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('records per-harness reuse decisions as strict booleans, empty clears', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('reuse.codex', 'true', file);
        setConfigValue('reuse.pi', 'false', file);
        expect(loadConfigFile(file).reuse).toEqual({ codex: true, pi: false });
        setConfigValue('reuse.codex', '', file);
        expect(loadConfigFile(file).reuse).toEqual({ pi: false });
        expect(() => setConfigValue('reuse.codex', 'maybe', file)).toThrow('true or false');
        expect(() => setConfigValue('reuse.gemini', 'true', file)).toThrow('Unknown reuse');
        // auto never shipped; it is just an unknown key like any other.
        expect(() => setConfigValue('auto', 'true', file)).toThrow('Invalid config key');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('round-trips guards.allowModels the same way', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('guards.allowModels', '["deepseek-v4-*", "glm-5.2*", "glm-5.3"]', file);
        expect(loadConfigFile(file).guards?.allowModels).toEqual([
            'deepseek-v4-*',
            'glm-5.2*',
            'glm-5.3',
        ]);
        setConfigValue('guards.allowModels', 'minimax-m2.5*, qwen3-coder*', file);
        expect(loadConfigFile(file).guards?.allowModels).toEqual(['minimax-m2.5*', 'qwen3-coder*']);
        setConfigValue('guards.allowModels', '', file);
        expect(loadConfigFile(file).guards?.allowModels).toBeUndefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('renders reuse decisions and allowModels in the effective config', async () => {
        const { renderEffectiveConfig } = await import('./config.ts');
        const rendered = renderEffectiveConfig(
            { reuse: { codex: false, pi: true }, guards: { allowModels: ['deepseek-v4-*'] } },
            {},
        );
        expect(rendered).toContain('"codex": "false (file)"');
        expect(rendered).toContain('"pi": "true (file)"');
        expect(rendered).toContain('allowModels');
    });

    it('parses guards.denyWhenUnknown as a boolean and rejects other fields', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('guards.denyWhenUnknown', 'true', file);
        expect(loadConfigFile(file).guards?.denyWhenUnknown).toBe(true);
        setConfigValue('guards.denyWhenUnknown', 'false', file);
        expect(loadConfigFile(file).guards?.denyWhenUnknown).toBe(false);
        expect(() => setConfigValue('guards.denyWhenUnknown', 'maybe', file)).toThrow(
            'true or false',
        );
        expect(() => setConfigValue('guards.nope', 'x', file)).toThrow('Unknown guards field');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('shows guards in the effective config render', () => {
        const rendered = renderEffectiveConfig(
            { guards: { denyModels: ['gemini-3*'], denyWhenUnknown: true } },
            {},
        );
        const parsed = JSON.parse(rendered) as { guards?: Record<string, string> };
        expect(parsed.guards?.denyModels).toBe('["gemini-3*"] (file)');
        expect(parsed.guards?.denyWhenUnknown).toBe('true (file)');
    });
});

describe('initConfigFile', () => {
    it('writes the starter template and refuses to overwrite without force', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-init-'));
        const file = path.join(dir, 'config.json');
        initConfigFile(file);
        expect(loadConfigFile(file)).toEqual(CONFIG_TEMPLATE);
        expect(() => initConfigFile(file)).toThrow('already exists');
        initConfigFile(file, true);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('structuredOutput (#37)', () => {
    it('stores a boolean and clears on empty', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-so-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('openai.structuredOutput', 'true', file);
        expect(loadConfigFile(file).providers?.openai?.structuredOutput).toBe(true);
        setConfigValue('openai.structuredOutput', 'false', file);
        expect(loadConfigFile(file).providers?.openai?.structuredOutput).toBe(false);
        setConfigValue('openai.structuredOutput', '', file);
        expect(loadConfigFile(file).providers?.openai?.structuredOutput).toBeUndefined();
    });

    it('shows in the effective config, both ways', () => {
        for (const value of [true, false]) {
            const rendered = renderEffectiveConfig({
                providers: { openai: { structuredOutput: value } },
            });
            expect(JSON.parse(rendered).providers.openai.structuredOutput).toBe(`${value} (file)`);
        }
        expect(
            JSON.parse(renderEffectiveConfig({ providers: { openai: { model: 'x' } } })).providers
                .openai.structuredOutput,
        ).toBeUndefined();
    });

    it('refuses it on a provider that would never read it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-so-'));
        const file = path.join(dir, 'config.json');
        expect(() => setConfigValue('anthropic.structuredOutput', 'true', file)).toThrow(
            /openai provider only/,
        );
        // The alias resolves to openai, so it is accepted.
        expect(() => setConfigValue('openai-compat.structuredOutput', 'true', file)).not.toThrow();
    });

    it('refuses a value that is neither true nor false', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-so-'));
        const file = path.join(dir, 'config.json');
        expect(() => setConfigValue('openai.structuredOutput', 'yes', file)).toThrow(
            /must be true or false/,
        );
    });
});

describe('one provider, one source (#42)', () => {
    // The reported failure was a configured Kimi endpoint answering 401
    // because an ambient OPENAI_API_KEY replaced the configured key. The
    // defect is not which side wins a field: a baseUrl and an apiKey are one
    // credential, and drawing halves from two places builds a pairing that
    // exists in neither. So a provider's settings come from one place.
    it('takes the file whole when the file mentions this provider', () => {
        const settings = resolveProviderSettings(
            'openai',
            { providers: { openai: { apiKey: 'file-key', baseUrl: 'https://kimi.example/v1' } } },
            { OPENAI_API_KEY: 'ambient-key', OPENAI_BASE_URL: 'https://api.openai.com/v1' },
        );
        expect(settings.apiKey).toBe('file-key');
        expect(settings.baseUrl).toBe('https://kimi.example/v1');
    });

    it('does not fill a gap from the environment, which is how the pair got split', () => {
        // Endpoint from the file, key from the environment: exactly the
        // combination that answered 401, and exactly what a field-level
        // "file wins" rule would still produce.
        const settings = resolveProviderSettings(
            'openai',
            { providers: { openai: { baseUrl: 'https://kimi.example/v1' } } },
            { OPENAI_API_KEY: 'ambient-key' },
        );
        expect(settings.apiKey).toBeUndefined();
    });

    it('takes the environment whole when the file says nothing about it', () => {
        // A container or CI job that only exports variables keeps working,
        // and both halves come from the same place, so they still match.
        const settings = resolveProviderSettings(
            'openai',
            { providers: { 'gemini-api': { apiKey: 'g' } } },
            { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: 'https://gw.example/v1' },
        );
        expect(settings.apiKey).toBe('env-key');
        expect(settings.baseUrl).toBe('https://gw.example/v1');
    });

    it('counts an alias entry as the file mentioning it', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { gemini: { model: 'm' } } },
            { GEMINI_API_KEY: 'env-key' },
        );
        expect(settings.model).toBe('m');
        expect(settings.apiKey).toBeUndefined();
    });

    // What makes the file the source is the key being there, not what is
    // under it. Reading emptiness as silence let a provider slide back onto
    // the variables its entry was written to displace, and clearing the last
    // field is how an entry ends up empty in ordinary use.
    it('counts an emptied entry as the file mentioning it', () => {
        const config = { providers: { 'gemini-api': {} } };
        expect(providerConfiguredInFile('gemini-api', config)).toBe(true);
        expect(
            resolveProviderSettings('gemini-api', config, { GEMINI_API_KEY: 'env-key' }),
        ).toEqual({});
    });

    it('counts an emptied alias entry too', () => {
        const config = { providers: { gemini: {} } };
        expect(providerConfiguredInFile('gemini-api', config)).toBe(true);
        expect(
            resolveProviderSettings('gemini-api', config, { GEMINI_API_KEY: 'env-key' }),
        ).toEqual({});
    });

    it('leaves an emptied entry behind when the last field is cleared', () => {
        // The path that produces one without anybody hand-editing JSON.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-empty-'));
        const configPath = path.join(dir, 'config.json');
        setConfigValue('openai.structuredOutput', 'true', configPath);
        setConfigValue('openai.structuredOutput', '', configPath);
        const config = loadConfigFile(configPath);
        expect(config.providers?.openai).toEqual({});
        expect(resolveProviderSettings('openai', config, { OPENAI_API_KEY: 'env-key' })).toEqual(
            {},
        );
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('labels the source it actually used', () => {
        const fromEnv = JSON.parse(
            renderEffectiveConfig({}, { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://x/v1' }),
        ) as { providers: Record<string, Record<string, string>> };
        expect(fromEnv.providers.openai.baseUrl).toBe('https://x/v1 (env)');
        const fromFile = JSON.parse(
            renderEffectiveConfig(
                { providers: { openai: { baseUrl: 'https://y/v1' } } },
                { OPENAI_BASE_URL: 'https://x/v1' },
            ),
        ) as { providers: Record<string, Record<string, string>> };
        expect(fromFile.providers.openai.baseUrl).toBe('https://y/v1 (file)');
    });

    it('prints one row per provider, under its canonical name', () => {
        // An alias entry and a bound variable are one provider. Two rows put
        // a value on screen that no run reads, in a view whose whole job is
        // to say what runs.
        const shown = JSON.parse(
            renderEffectiveConfig(
                { providers: { gemini: { model: 'm' } } },
                { GEMINI_API_KEY: 'env-key' },
            ),
        ) as { providers: Record<string, Record<string, string>> };
        expect(Object.keys(shown.providers)).toEqual(['gemini-api']);
        expect(shown.providers['gemini-api']).toEqual({ model: 'm (file)' });
    });

    it('shows an emptied entry rather than hiding why the variables went quiet', () => {
        const shown = JSON.parse(
            renderEffectiveConfig({ providers: { 'gemini-api': {} } }, { GEMINI_API_KEY: 'k' }),
        ) as { providers: Record<string, Record<string, string>> };
        expect(shown.providers['gemini-api']).toEqual({});
    });
});

describe('the retired endpoint bindings tell their users (#42)', () => {
    it('refuses when the variable is set and the file has no endpoint', () => {
        // Silence here would deliver a gateway's key, and the image beside
        // it, to the vendor's own endpoint.
        expect(
            () =>
                assertNoRetiredEndpointBinding(
                    'anthropic',
                    { apiKey: 'k' },
                    {
                        ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
                    },
                ),
            // The reference is the platform's own spelling, the same way the
            // masking test below checks it. Asserting the POSIX form
            // unconditionally is what kept Windows CI red from 3.17.0.
        ).toThrow(
            process.platform === 'win32'
                ? /ANTHROPIC_BASE_URL.*anthropic\.baseUrl \$env:ANTHROPIC_BASE_URL/s
                : /ANTHROPIC_BASE_URL.*anthropic\.baseUrl "\$ANTHROPIC_BASE_URL"/s,
        );
    });

    it('masks credentials the endpoint URL carries, since errors travel', () => {
        // An error lands in logs, issue reports and screenshots.
        let message = '';
        try {
            assertNoRetiredEndpointBinding(
                'openai',
                { apiKey: 'k' },
                {
                    OPENAI_BASE_URL: 'https://user:hunter2@gw.example/v1',
                },
            );
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain('gw.example');
        expect(message).not.toContain('hunter2');
        // The command is runnable because the shell expands the variable, so
        // nobody is asked to paste a masked value back into their config.
        // The reference is the platform's own spelling, since a POSIX form is
        // not runnable where this bug was reported from.
        expect(message).toContain(
            process.platform === 'win32'
                ? 'openai.baseUrl $env:OPENAI_BASE_URL'
                : 'openai.baseUrl "$OPENAI_BASE_URL"',
        );
        expect(message).not.toMatch(/baseUrl \S*\*\*\*/);
    });

    it('says nothing to anyone the change did not affect', () => {
        // Endpoint in the file: the variable is irrelevant.
        expect(() =>
            assertNoRetiredEndpointBinding(
                'anthropic',
                { baseUrl: 'https://x/v1' },
                {
                    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
                },
            ),
        ).not.toThrow();
        // No variable: the default endpoint was always what they used.
        expect(() =>
            assertNoRetiredEndpointBinding('anthropic', { apiKey: 'k' }, {}),
        ).not.toThrow();
        // A provider with no retired binding.
        expect(() =>
            assertNoRetiredEndpointBinding('gemini-api', {}, { ANTHROPIC_BASE_URL: 'https://x' }),
        ).not.toThrow();
    });
});

describe('setConfigValue accepts only names a provider answers to', () => {
    // 'OpenAI.apiKey' used to be saved verbatim, reported as saved, and then
    // never read: the file is read back by exact lowercase key, so the
    // environment quietly kept answering for the provider the user thought
    // they had just configured, and the effective view showed two rows for
    // one provider.
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        return path.join(dir, 'config.json');
    }

    it('folds a mis-cased provider onto the key reads use', () => {
        const file = tmpConfig();
        setConfigValue('OpenAI.apiKey', 'sk-value-123456', file);

        const config = loadConfigFile(file);
        expect(config.providers?.openai?.apiKey).toBe('sk-value-123456');
        expect(config.providers && 'OpenAI' in config.providers).toBe(false);
    });

    it('keeps an alias as the storage key, folded', () => {
        const file = tmpConfig();
        setConfigValue('Gemini.apiKey', 'g-key-123456', file);

        const config = loadConfigFile(file);
        expect(config.providers?.gemini?.apiKey).toBe('g-key-123456');
    });

    it('refuses a name no provider answers to, naming the valid ones', () => {
        const file = tmpConfig();
        expect(() => setConfigValue('opeanai.apiKey', 'sk-x', file)).toThrow(
            /Unknown provider: opeanai/,
        );
        expect(fs.existsSync(file)).toBe(false);
    });
});

describe('saved copies of the openai slot (#67)', () => {
    // Switching gateways used to overwrite providers.openai and lose the
    // previous key. A saved copy is inert data: resolution, guards, and the
    // env bindings never read it, and only save/use write it.
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-saved-'));
        return path.join(dir, 'config.json');
    }

    const dashscope = {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-alibaba-123456',
        model: 'qwen3-vl-plus',
    };
    const ark = {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'ak-bytedance-123456',
        model: 'doubao-seed-1.6-vision',
    };

    function seed(file: string, settings: Record<string, unknown>): void {
        fs.writeFileSync(file, JSON.stringify({ providers: { openai: settings } }));
    }

    it('snapshots the slot under a label and swaps another one in, whole', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);

        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: { openai: ark },
                saved: JSON.parse(fs.readFileSync(file, 'utf-8')).saved,
            }),
        );
        saveProviderBundle('openai', 'ark', file);
        useProviderBundle('openai', 'dashscope', false, file);

        const config = loadConfigFile(file);
        expect(config.providers?.openai).toEqual(dashscope);
        // The other bundle survived the switch: that is the whole point.
        expect(config.saved?.openai?.ark).toEqual(ark);
    });

    it('refuses to drop an unsaved active slot, and --discard means it', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);
        // The user edits the slot afterwards; the edit is nowhere saved.
        setConfigValue('openai.model', 'qwen3-vl-max', file);

        expect(() => useProviderBundle('openai', 'dashscope', false, file)).toThrow(
            /not saved under any label/,
        );
        useProviderBundle('openai', 'dashscope', true, file);
        expect(loadConfigFile(file).providers?.openai).toEqual(dashscope);
    });

    it('folds an alias-spelled section into the snapshot and clears it on use', () => {
        const file = tmpConfig();
        // openai-compat is an alias spelling of the same slot; the canonical
        // key wins on conflict, and use must remove every spelling or the
        // leftover section would keep merging into reads beside the bundle.
        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: {
                    'openai-compat': { baseUrl: 'https://old.example/v1', model: 'old-model' },
                    openai: { model: 'qwen3-vl-plus', apiKey: 'sk-alibaba-123456' },
                },
            }),
        );
        saveProviderBundle('openai', 'merged', file);

        const saved = loadConfigFile(file).saved?.openai?.merged;
        expect(saved?.model).toBe('qwen3-vl-plus');
        expect(saved?.baseUrl).toBe('https://old.example/v1');

        useProviderBundle('openai', 'merged', false, file);
        const config = loadConfigFile(file);
        expect(config.providers && 'openai-compat' in config.providers).toBe(false);
        expect(config.providers?.openai).toEqual(saved);
    });

    it('refuses labels that are not labels and slots that are not openai', () => {
        const file = tmpConfig();
        seed(file, dashscope);

        expect(() => saveProviderBundle('openai', 'Bad Label', file)).toThrow(/lowercase/);
        expect(() => saveProviderBundle('gemini-api', 'work', file)).toThrow(
            /Saved copies exist only for the openai slot/,
        );
        expect(() => saveProviderBundle('openai', 'empty', tmpConfig())).toThrow(/Nothing to save/);
    });

    it('names the saved labels when the asked-for one does not exist', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);

        expect(() => useProviderBundle('openai', 'ark', false, file)).toThrow(/Saved: dashscope/);
    });

    it('masks every saved key in the effective view', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);

        const view = renderEffectiveConfig(loadConfigFile(file), {});
        expect(view).toContain('dashscope');
        expect(view).not.toContain('sk-alibaba-123456');
    });

    it('masks each key in a saved comma-separated apiKey, not the joined blob', () => {
        const view = renderEffectiveConfig(
            {
                saved: {
                    openai: {
                        ark: { apiKey: 'first-key-aaaa,second-key-bbbb' },
                    },
                },
            },
            {},
        );
        expect(view).toContain('first-...aa');
        expect(view).toContain('second...bb');
        expect(view).toContain('first-...aa, second...bb');
        expect(view).not.toContain('first-key-aaaa');
        expect(view).not.toContain('second-key-bbbb');
        expect(view).not.toContain('first-...bb');
    });

    it('survives ordinary config set round-trips untouched', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);
        setConfigValue('gemini-api.apiKey', 'g-key-123', file);

        expect(loadConfigFile(file).saved?.openai?.dashscope).toEqual(dashscope);
    });
});

describe('the saved section survives hostile labels and hand edits (3.21.0 acceptance)', () => {
    // An independent acceptance run against the released 3.21.0 found `use
    // openai constructor` walking the prototype chain: Object's constructor
    // came back as the bundle, spread into {}, and an unsaved key died under
    // a success message. The section is also hand-editable, so every shape it
    // can hold must fail with a sentence, not a stack trace, and never crash
    // config show, which is the command that would have shown what is wrong.
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-hostile-'));
        return path.join(dir, 'config.json');
    }
    const dashscope = {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-alibaba-123456',
        model: 'qwen3-vl-plus',
    };

    it('treats constructor as the absent label it is, and the file stays put', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({ providers: { openai: dashscope }, saved: { openai: { dashscope } } }),
        );
        const before = fs.readFileSync(file, 'utf-8');

        expect(() => useProviderBundle('openai', 'constructor', false, file)).toThrow(
            /No saved copy named "constructor"\. Saved: dashscope\./,
        );
        expect(() => useProviderBundle('openai', 'constructor', true, file)).toThrow(
            /No saved copy named "constructor"/,
        );
        expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    });

    it('a label spelled constructor still works as an own property', () => {
        // The fix is own-property reads, not a blocklist: someone who really
        // names a gateway "constructor" gets a working saved copy.
        const file = tmpConfig();
        fs.writeFileSync(file, JSON.stringify({ providers: { openai: dashscope } }));
        saveProviderBundle('openai', 'constructor', file);
        useProviderBundle('openai', 'constructor', false, file);

        expect(loadConfigFile(file).providers?.openai).toEqual(dashscope);
    });

    it('refuses a hand-written bundle that is not an object, naming the path', () => {
        const file = tmpConfig();
        for (const bad of [null, 12345, true, [], 'notanobject'] as const) {
            fs.writeFileSync(
                file,
                JSON.stringify({
                    providers: { openai: dashscope },
                    saved: { openai: { good: dashscope, bad } },
                }),
            );
            expect(() => useProviderBundle('openai', 'bad', false, file)).toThrow(
                /saved copy "bad" .* is not an object/,
            );
            // The good label still works beside the bad one.
            useProviderBundle('openai', 'good', false, file);
        }
    });

    it('save refuses a garbage saved section with a sentence, not a JS error', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({ providers: { openai: dashscope }, saved: 'garbage' }),
        );
        expect(() => saveProviderBundle('openai', 'x', file)).toThrow(
            /"saved" section .* is not an object/,
        );
    });

    it('config show reports malformed entries in place instead of crashing', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: { openai: dashscope },
                saved: { openai: { ok: dashscope, broken: null, alsobad: 'text' } },
            }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).toContain('ok');
        expect(view).toContain('(malformed');
        expect(view).not.toContain('sk-alibaba-123456');

        // A garbage root gets one malformed note, and show still renders.
        fs.writeFileSync(
            file,
            JSON.stringify({ providers: { openai: dashscope }, saved: 'garbage' }),
        );
        expect(() => renderEffectiveConfig(loadConfigFile(file), {})).not.toThrow();
    });

    it('reports whether save replaced an existing label', () => {
        const file = tmpConfig();
        fs.writeFileSync(file, JSON.stringify({ providers: { openai: dashscope } }));

        expect(saveProviderBundle('openai', 'prod', file)).toBe(false);
        expect(saveProviderBundle('openai', 'prod', file)).toBe(true);
    });
});

describe('the neighbours of the hotfix hold the same line (review round 2)', () => {
    // Three independent reviews of the hotfix found the same two disciplines,
    // own-property reads and shapes-fail-with-a-sentence, enforced only in
    // the code the hotfix touched. These pin the neighbours.
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-round2-'));
        return path.join(dir, 'config.json');
    }
    const dashscope = {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-alibaba-123456',
        model: 'qwen3-vl-plus',
    };

    it('config set refuses constructor and __proto__ as provider names', () => {
        const file = tmpConfig();
        expect(() => setConfigValue('constructor.apiKey', 'sk-x', file)).toThrow(
            /Unknown provider: constructor/,
        );
        expect(() => setConfigValue('__proto__.apiKey', 'sk-poison', file)).toThrow(
            /Unknown provider: __proto__/,
        );
        // And the running process was not polluted on the way through.
        expect(({} as Record<string, unknown>).apiKey).toBeUndefined();
        expect(fs.existsSync(file)).toBe(false);
    });

    it('show reports a non-string field in the active slot instead of crashing', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({ providers: { openai: { apiKey: 123, model: 'qwen3-vl-plus' } } }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).toContain('(malformed: not a string)');
        expect(view).toContain('qwen3-vl-plus');
    });

    it('show reports a malformed providers root instead of inventing providers', () => {
        const file = tmpConfig();
        fs.writeFileSync(file, JSON.stringify({ providers: 'nope' }));
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).toContain('is not an object');
        expect(view).not.toContain('"0"');
    });

    it('set and use refuse a malformed providers root with a sentence', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({ providers: 'nope', saved: { openai: { a: dashscope } } }),
        );
        expect(() => setConfigValue('openai.model', 'x', file)).toThrow(
            /"providers" section .* is not an object/,
        );
        expect(() => useProviderBundle('openai', 'a', true, file)).toThrow(
            /"providers" section .* is not an object/,
        );
    });

    it('use tells the same story as save about a malformed saved section', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({ providers: { openai: dashscope }, saved: 'garbage' }),
        );
        expect(() => useProviderBundle('openai', 'a', false, file)).toThrow(
            /"saved" section .* is not an object/,
        );
    });

    it('use refuses a bundle that would empty the slot or corrupt it', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: { openai: dashscope },
                saved: {
                    openai: {
                        empty: {},
                        strangers: { totallyUnknown: 'x' },
                        badkey: { apiKey: 123, model: 'm' },
                        badbody: { extraBody: [], model: 'm' },
                        newer: { model: 'm', futureField: { anything: true } },
                    },
                },
            }),
        );
        expect(() => useProviderBundle('openai', 'empty', true, file)).toThrow(
            /holds none of the openai fields/,
        );
        expect(() => useProviderBundle('openai', 'strangers', true, file)).toThrow(
            /holds none of the openai fields/,
        );
        expect(() => useProviderBundle('openai', 'badkey', true, file)).toThrow(
            /non-string apiKey/,
        );
        expect(() => useProviderBundle('openai', 'badbody', true, file)).toThrow(
            /extraBody that is not an object/,
        );
        // A field this version does not know is a newer version's business,
        // not a reason to refuse.
        useProviderBundle('openai', 'newer', true, file);
        expect(loadConfigFile(file).providers?.openai?.model).toBe('m');
    });

    it('a key riding another displayed field never prints in full', () => {
        const file = tmpConfig();
        const key = 'sk-test-123456789012345';
        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: {
                    openai: { apiKey: key, baseUrl: `https://gw.example/${key}`, model: 'm' },
                },
                saved: {
                    openai: {
                        leak: {
                            apiKey: key,
                            baseUrl: `https://gw.example/${key}`,
                            model: `note-${key}`,
                        },
                    },
                },
            }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).not.toContain(key);
        expect(view).toContain('[redacted]');
    });

    it('a slot named __proto__ in saved renders without polluting anything', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({
                saved: { ['__proto__']: { polluted: { apiKey: 'sk-safe-123456' } } },
            }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(view).toContain('polluted');
    });

    it('a saved root that is an array is malformed, not silently empty', () => {
        const file = tmpConfig();
        fs.writeFileSync(file, JSON.stringify({ providers: { openai: dashscope }, saved: [] }));
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).toContain('is not an object');
    });
});

describe('the display boundary is final, and entry shells are validated (round 3)', () => {
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-round3-'));
        return path.join(dir, 'config.json');
    }
    const key = 'sk-test-123456789012345';

    it('a key riding the top-level proxy or a guard pattern never prints', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({
                proxy: `https://proxy.example/path?token=${key}`,
                providers: {
                    openai: { apiKey: key, baseUrl: 'https://gw.example/v1', model: 'm' },
                },
                guards: { denyModels: [`prefix-${key}`] },
            }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).not.toContain(key);
    });

    it('a saved-only key is redacted from every corner of the view too', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({
                proxy: `https://proxy.example/?t=${key}`,
                saved: { openai: { a: { apiKey: key, model: 'm' } } },
            }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).not.toContain(key);
    });

    it('a provider entry that is not an object is reported, not shown as {}', () => {
        const file = tmpConfig();
        fs.writeFileSync(file, JSON.stringify({ providers: { openai: 'not-an-object' } }));
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).toContain('providers.openai');
        expect(view).toContain('is not an object');
        expect(() => setConfigValue('openai.model', 'm', file)).toThrow(
            /"providers.openai" .* is not an object/,
        );
    });

    it('malformed top-level scalars and reuse are reported, never crashed on', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({ provider: 123, proxy: 456, reuse: 'abc', providers: {} }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).toContain('(malformed: not a string)');
        expect(view).toContain('reuse');
        expect(view).toContain('is not an object');
        expect(view).not.toContain('"0"');
    });
});

describe('the display boundary holds under round-4 attacks', () => {
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-round4-'));
        return path.join(dir, 'config.json');
    }

    it('collects keys from the env the render was asked to describe', () => {
        const key = 'env-injected-key-12345';
        const view = renderEffectiveConfig(
            {
                proxy: `https://proxy.example/?token=${key}`,
                guards: { denyModels: [`prefix-${key}`] },
            },
            { OPENAI_API_KEY: key },
        );

        expect(view).not.toContain(key);
    });

    it('redacts short keys from other fields too', () => {
        const view = renderEffectiveConfig(
            {
                proxy: 'https://proxy.example/?t=abcde',
                providers: { openai: { apiKey: 'abcde', baseUrl: 'https://gw.example/v1' } },
            },
            {},
        );

        expect(view).not.toContain('abcde');
    });

    it('a key that collides with JSON syntax cannot break the view', () => {
        const view = renderEffectiveConfig(
            {
                providers: { openai: { apiKey: '"proxy"', model: 'm' } },
                proxy: 'https://proxy.example/',
            },
            {},
        );

        expect(() => JSON.parse(view)).not.toThrow();
        expect(JSON.parse(view)).toHaveProperty('proxy');
    });

    it('a malformed alias is reported beside the healthy row that runs', () => {
        const file = tmpConfig();
        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: {
                    'openai-compat': 'bad',
                    openai: {
                        apiKey: 'healthy-key-123',
                        baseUrl: 'https://healthy.example/v1',
                        model: 'healthy-model',
                    },
                },
            }),
        );
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).toContain('healthy-model');
        expect(view).toContain('providers.openai-compat');
        expect(view).toContain('is not an object');
        // And the write path refuses whichever spelling the user types.
        expect(() => setConfigValue('openai.model', 'm', file)).toThrow(/providers.openai-compat/);
        expect(() => setConfigValue('openai-compat.model', 'm', file)).toThrow(
            /providers.openai-compat/,
        );
    });

    it('the execute boundary fails in a sentence, not a TypeError', () => {
        expect(() => assertReadableConfig({ provider: 123 } as never, '/tmp/c.json')).toThrow(
            /"provider" .* is not a string/,
        );
        expect(() => assertReadableConfig({ proxy: [] } as never, '/tmp/c.json')).toThrow(
            /"proxy" .* is not a string/,
        );
        expect(() =>
            assertReadableConfig({ providers: { openai: 'junk' } } as never, '/tmp/c.json'),
        ).toThrow(/"providers.openai" .* is not an object/);
        expect(() =>
            assertReadableConfig({ providers: { openai: { apiKey: 9 } } } as never, '/tmp/c.json'),
        ).toThrow(/non-string apiKey/);
        expect(() => assertReadableConfig({ reuse: 'abc' } as never, '/tmp/c.json')).toThrow(
            /"reuse" .* is not an object/,
        );
        // A healthy partial config passes untouched.
        assertReadableConfig({ providers: { openai: { model: 'm' } } }, '/tmp/c.json');
        assertReadableConfig({}, '/tmp/c.json');
    });
});

describe('property names and tiny keys cannot leak either (round 5)', () => {
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-round5-'));
        return path.join(dir, 'config.json');
    }

    it('a saved label that IS the key never prints, through the public flow', () => {
        // One wrong paste away: config save openai <key>. The label becomes a
        // JSON property name, which value-level scrubbing alone never saw.
        const file = tmpConfig();
        const key = 'secret-token-lbl';
        fs.writeFileSync(file, '{}');
        setConfigValue('openai.apiKey', key, file);
        setConfigValue('openai.baseUrl', 'https://gw.example/v1', file);
        saveProviderBundle('openai', key, file);
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        expect(view).not.toContain(key);
        expect(() => JSON.parse(view)).not.toThrow();
    });

    it('labels live in values, so colliding labels stay distinct rows', () => {
        // User data never becomes a property name in this view: labels ride
        // inside value strings, so redaction covers them and no dedupe layer
        // exists to leak through or to overwrite rows.
        const view = renderEffectiveConfig(
            {
                providers: { openai: { apiKey: 'k-123456' } },
                saved: {
                    openai: {
                        'k-123456': { model: 'model-aaa', apiKey: 'x-111111' },
                        'k-123456x': { model: 'model-bbb', apiKey: 'y-222222' },
                    },
                },
            } as never,
            {},
        );
        const parsed = JSON.parse(view) as { saved: string[] };

        expect(parsed.saved).toHaveLength(2);
        expect(view).toContain('model-aaa');
        expect(view).toContain('model-bbb');
        expect(view).not.toContain('k-123456');
    });

    it('the #2-suffix reassembly flow, exactly as public commands run it', () => {
        // The round-5 counterexample verbatim: two labels that ARE their own
        // one-character keys redact identically, and the dedupe suffix for
        // the second used to spell out a third key of "#2". Three rounds of
        // config set + config save, nothing hand-written.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-suffix-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('openai.baseUrl', 'https://gw.example/v1', file);
        setConfigValue('openai.apiKey', 'x', file);
        saveProviderBundle('openai', 'x', file);
        setConfigValue('openai.apiKey', 'y', file);
        saveProviderBundle('openai', 'y', file);
        setConfigValue('openai.apiKey', '#2', file);
        saveProviderBundle('openai', 'hash', file);
        const view = renderEffectiveConfig(loadConfigFile(file), {});

        const parsed = JSON.parse(view) as { saved: string[] };
        expect(parsed.saved).toHaveLength(3);
        expect(view).not.toContain('#2');
    });

    it('name-shaped provider spellings stay four distinct note lines', () => {
        // The round-5 overwrite counterexample: names equal to a redacted
        // form, and names that contain one, used to collapse onto each other
        // through the keyed view. As note VALUES they cannot collide, even
        // when redaction makes two of them read the same.
        const view = renderEffectiveConfig(
            {
                providers: {
                    openai: { apiKey: '#2', model: 'm' },
                    '#2': { model: 'a' },
                    '[redacted]': { model: 'b' },
                    '#2tail': { model: 'c' },
                    '[redacted]tail': { model: 'd' },
                },
            } as never,
            {},
        );

        const parsed = JSON.parse(view) as { notes: string[] };
        expect(parsed.notes).toHaveLength(4);
        expect(view).not.toContain('#2');
    });

    it('a two-character key is scrubbed from every value, readability be damned', () => {
        const view = renderEffectiveConfig(
            {
                proxy: 'https://proxy.example/?t=ab',
                providers: { openai: { apiKey: 'ab', model: 'm' } },
            },
            {},
        );

        expect(view).not.toContain('?t=ab');
        expect(view).toContain('[redacted]');
    });

    it('guards joins the hostile-input boundary on all three surfaces', () => {
        const file = tmpConfig();
        fs.writeFileSync(file, JSON.stringify({ guards: 'bad' }));

        expect(() => assertReadableConfig(loadConfigFile(file), file)).toThrow(
            /"guards" .* is not an object/,
        );
        expect(renderEffectiveConfig(loadConfigFile(file), {})).toContain('is not an object');
        expect(() => setConfigValue('guards.denyWhenUnknown', 'true', file)).toThrow(
            /"guards" section .* is not an object/,
        );
        expect(() => assertReadableConfig({ guards: { denyModels: 'x' } } as never, file)).toThrow(
            /"guards.denyModels" .* is not an array/,
        );
    });
});

describe('a stranger reuse key is reported even when it is the only note', () => {
    it('renders the note with no earlier producer attaching the array', () => {
        // The notes array used to be attached mid-function: with no earlier
        // provider diagnostic, a stranger reuse name pushed later went
        // nowhere, and the structural test survived only through the shared
        // array reference.
        const alone = JSON.parse(
            renderEffectiveConfig({ reuse: { stranger: true } } as never, {}),
        ) as { notes?: string[] };
        expect(alone.notes?.join('\n')).toContain('reuse.stranger is not a known harness');

        const mixed = JSON.parse(
            renderEffectiveConfig({ reuse: { claude: true, stranger: true } } as never, {}),
        ) as { notes?: string[]; reuse?: Record<string, string> };
        expect(mixed.reuse?.claude).toContain('true');
        expect(mixed.notes?.join('\n')).toContain('reuse.stranger');
    });
});

describe('every property name in the view is a constant (structural invariant)', () => {
    it('holds under a config stuffed with user data in every name position', () => {
        const view = renderEffectiveConfig(
            {
                provider: 'openai',
                proxy: 'https://proxy.example/',
                providers: {
                    openai: { apiKey: 'sk-123456', model: 'm' },
                    'weird-name': { apiKey: 'other-key-123' },
                    'openai-compat': 'junk',
                },
                saved: { openai: { anylabel: { model: 'm' } }, oddslot: { l: { model: 'x' } } },
                reuse: { claude: true, strangerharness: true },
                guards: { denyModels: ['a*'], denyWhenUnknown: false },
            } as never,
            {},
        );
        const parsed = JSON.parse(view) as Record<string, unknown>;
        const allowed = new Set([
            'providers',
            'saved',
            'notes',
            'provider',
            'proxy',
            'guards',
            'reuse',
            '(malformed)',
            'apiKey',
            'baseUrl',
            'model',
            'structuredOutput',
            'extraBody',
            'denyModels',
            'allowModels',
            'denyWhenUnknown',
            'cooldown',
            ...listProviders(),
            ...REUSE_HARNESSES,
        ]);
        const walk = (node: unknown): void => {
            if (Array.isArray(node)) {
                for (const item of node) walk(item);
                return;
            }
            if (node && typeof node === 'object') {
                for (const [key, item] of Object.entries(node)) {
                    expect(allowed.has(key), `unexpected property name: ${key}`).toBe(true);
                    walk(item);
                }
            }
        };
        walk(parsed);
        // The user-data spellings appear only inside values.
        expect(view).toContain('weird-name');
        expect(view).toContain('strangerharness');
        expect(view).toContain('oddslot');
    });
});

describe('comma-separated API keys', () => {
    it('scrubs every key from a comma-separated API key setting', () => {
        const first = 'alpha-secret-value';
        const second = 'bravo-secret-value';
        const config = {
            providers: {
                'gemini-api': {
                    apiKey: `${first}, ${second}`,
                    model: `copied ${first} and ${second}`,
                },
            },
        };
        const view = renderEffectiveConfig(config, {} as NodeJS.ProcessEnv);
        expect(view).not.toContain(first);
        expect(view).not.toContain(second);
        expect(JSON.parse(view).providers['gemini-api'].apiKey).toMatch(/, /);
    });

    it('takes a comma list from the file whole and ignores GEMINI_API_KEY', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { 'gemini-api': { apiKey: 'file-key-aaaa,file-key-bbbb' } } },
            { GEMINI_API_KEY: 'env-key-cccc,env-key-dddd' },
        );
        expect(splitApiKeys(settings.apiKey)).toEqual(['file-key-aaaa', 'file-key-bbbb']);
    });

    it('yields two keys from an env-only GEMINI_API_KEY list', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            {},
            { GEMINI_API_KEY: 'env-key-aaaa, env-key-bbbb' },
        );
        expect(splitApiKeys(settings.apiKey)).toEqual(['env-key-aaaa', 'env-key-bbbb']);
    });

    it('does not pick up the env when the file names gemini-api with an empty or hollow apiKey', () => {
        expect(
            resolveProviderSettings(
                'gemini-api',
                { providers: { 'gemini-api': { apiKey: '' } } },
                { GEMINI_API_KEY: 'env-key-aaaa' },
            ).apiKey,
        ).toBe('');
        expect(
            resolveProviderSettings(
                'gemini-api',
                { providers: { 'gemini-api': {} } },
                { GEMINI_API_KEY: 'env-key-aaaa' },
            ).apiKey,
        ).toBeUndefined();
    });

    it('treats an env value of only commas as no key', () => {
        const settings = resolveProviderSettings('gemini-api', {}, { GEMINI_API_KEY: ', ,' });
        expect(settings.apiKey).toBeUndefined();
        const view = renderEffectiveConfig({}, { GEMINI_API_KEY: ', ,' });
        expect(JSON.parse(view).providers?.['gemini-api']).toBeUndefined();
    });
});

describe('GEMINI_BASE_URL', () => {
    it('is read when the file does not name gemini-api', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            {},
            { GEMINI_API_KEY: 'env-key-aaaa', GEMINI_BASE_URL: 'https://gemini-gw.example/v1' },
        );
        expect(settings.apiKey).toBe('env-key-aaaa');
        expect(settings.baseUrl).toBe('https://gemini-gw.example/v1');
    });

    it('ignores ambient GEMINI_BASE_URL when the file names gemini-api without a baseUrl', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { 'gemini-api': { apiKey: 'k' } } },
            { GEMINI_BASE_URL: 'https://gemini-gw.example/v1' },
        );
        expect(settings.apiKey).toBe('k');
        expect(settings.baseUrl).toBeUndefined();
        expect(() =>
            assertNoRetiredEndpointBinding(
                'gemini-api',
                { apiKey: 'k' },
                { GEMINI_BASE_URL: 'https://gemini-gw.example/v1' },
            ),
        ).not.toThrow();
    });
});

describe('cooldown config', () => {
    it('round-trips on and off, and rejects anything else', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cd-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('cooldown', 'off', file);
        expect(loadConfigFile(file).cooldown).toBe('off');
        setConfigValue('cooldown', 'on', file);
        expect(loadConfigFile(file).cooldown).toBe('on');
        expect(() => setConfigValue('cooldown', 'maybe', file)).toThrow(/on or off/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('shows on (default) when absent, and the file value otherwise', () => {
        const absent = JSON.parse(renderEffectiveConfig({}, {})) as { cooldown?: string };
        expect(absent.cooldown).toBe('on (default)');
        const off = JSON.parse(renderEffectiveConfig({ cooldown: 'off' }, {})) as {
            cooldown?: string;
        };
        expect(off.cooldown).toBe('off (file)');
    });

    it('fails assertReadableConfig when cooldown is not a string', () => {
        expect(() => assertReadableConfig({ cooldown: true } as never, '/tmp/c.json')).toThrow(
            /"cooldown"/,
        );
    });
});
