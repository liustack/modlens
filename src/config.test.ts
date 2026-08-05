import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    CONFIG_TEMPLATE,
    defaultProviderName,
    initConfigFile,
    loadConfigFile,
    renderEffectiveConfig,
    resolveProviderSettings,
    setConfigValue,
} from './config.ts';

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
    it('env vars override config file values, unbound fields pass through', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { 'gemini-api': { apiKey: 'from-file', model: 'm1' } } },
            { GEMINI_API_KEY: 'from-env' },
        );
        expect(settings.apiKey).toBe('from-env');
        expect(settings.model).toBe('m1');
    });

    it('binds openai and anthropic base urls from env', () => {
        const settings = resolveProviderSettings(
            'openai',
            {},
            {
                OPENAI_API_KEY: 'k',
                OPENAI_BASE_URL: 'https://gw.example.com/v1',
            },
        );
        expect(settings.baseUrl).toBe('https://gw.example.com/v1');
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

    it('merges env vars over the file and labels each value source', () => {
        const rendered = renderEffectiveConfig(
            { provider: 'gemini-api', providers: { 'gemini-api': { model: 'm1' } } },
            { GEMINI_API_KEY: 'AIzaFromEnv12345' },
        );
        const parsed = JSON.parse(rendered) as {
            provider?: string;
            providers: Record<string, Record<string, string>>;
        };
        expect(parsed.provider).toBe('gemini-api');
        // apiKey came from the environment, masked, and tagged env.
        expect(parsed.providers['gemini-api'].apiKey).toMatch(/\(env\)$/);
        expect(parsed.providers['gemini-api'].apiKey).not.toContain('FromEnv');
        // model came from the file, tagged file.
        expect(parsed.providers['gemini-api'].model).toBe('m1 (file)');
    });

    it('rejects malformed json with a fix hint', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, '{broken');
        expect(() => loadConfigFile(file)).toThrow('Fix or delete the file');
        fs.rmSync(dir, { recursive: true, force: true });
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
