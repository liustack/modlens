import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Layered configuration: CLI flags > environment variables > ~/.modlens/config.json > built-ins.

export interface ProviderSettings {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
}

export interface ModlensConfig {
    provider?: string;
    providers?: Record<string, ProviderSettings>;
}

export const CONFIG_DIR = path.join(os.homedir(), '.modlens');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const ENV_BINDINGS: Record<string, Partial<Record<keyof ProviderSettings, string>>> = {
    'gemini-api': { apiKey: 'GEMINI_API_KEY' },
    openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
};

export function loadConfigFile(configPath = CONFIG_PATH): ModlensConfig {
    let raw: string;
    try {
        raw = fs.readFileSync(configPath, 'utf-8');
    } catch {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return parsed as ModlensConfig;
    } catch (error) {
        throw new Error(
            `Failed to parse ${configPath}: ${(error as Error).message}. Fix or delete the file.`,
        );
    }
}

export function defaultProviderName(config: ModlensConfig): string {
    return config.provider?.trim() || 'antigravity-cli';
}

/** Resolve settings for one provider with env vars overriding the config file. */
export function resolveProviderSettings(
    providerName: string,
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): ProviderSettings {
    const fromFile = config.providers?.[providerName] ?? {};
    const bindings = ENV_BINDINGS[providerName] ?? {};

    const settings: ProviderSettings = { ...fromFile };
    for (const [field, envName] of Object.entries(bindings) as Array<
        [keyof ProviderSettings, string]
    >) {
        const value = env[envName]?.trim();
        if (value) {
            settings[field] = value;
        }
    }
    return settings;
}

/** Set a dotted key like "gemini-api.apiKey" or "provider" and persist with 0600 perms. */
export function setConfigValue(dottedKey: string, value: string, configPath = CONFIG_PATH): void {
    const config = loadConfigFile(configPath);

    if (dottedKey === 'provider') {
        config.provider = value;
    } else {
        const dot = dottedKey.indexOf('.');
        if (dot <= 0 || dot === dottedKey.length - 1) {
            throw new Error(
                `Invalid config key: ${dottedKey}. Use "provider" or "<provider>.<apiKey|baseUrl|model>".`,
            );
        }
        const providerName = dottedKey.slice(0, dot);
        const field = dottedKey.slice(dot + 1);
        if (!['apiKey', 'baseUrl', 'model'].includes(field)) {
            throw new Error(`Unknown config field: ${field}. Use apiKey, baseUrl, or model.`);
        }
        config.providers ??= {};
        config.providers[providerName] ??= {};
        config.providers[providerName][field as keyof ProviderSettings] = value;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

export const CONFIG_TEMPLATE: ModlensConfig = {
    provider: 'antigravity-cli',
    providers: {
        'antigravity-cli': { model: 'gemini-3.6-flash-low' },
        'gemini-api': { apiKey: '', model: 'gemini-3.6-flash' },
        openai: { baseUrl: '', apiKey: '', model: '' },
        anthropic: { apiKey: '', model: 'claude-haiku-4-5-20251001' },
        'claude-cli': { model: 'haiku' },
    },
};

/** Write a starter config. Refuses to overwrite unless force is set. */
export function initConfigFile(configPath = CONFIG_PATH, force = false): void {
    if (!force && fs.existsSync(configPath)) {
        throw new Error(`${configPath} already exists. Use --force to overwrite.`);
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

/** Render the effective config with API keys masked. */
export function renderConfig(config: ModlensConfig): string {
    const masked: ModlensConfig = {
        ...config,
        providers: Object.fromEntries(
            Object.entries(config.providers ?? {}).map(([name, settings]) => [
                name,
                {
                    ...settings,
                    ...(settings.apiKey ? { apiKey: maskKey(settings.apiKey) } : {}),
                },
            ]),
        ),
    };
    return JSON.stringify(masked, null, 2);
}

function maskKey(key: string): string {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
}
