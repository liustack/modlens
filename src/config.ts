import * as fs from 'fs';
import { providerAliases } from './providers/index.ts';
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
    } catch (error) {
        // Only a missing file means "no config". Permissions or a directory in
        // its place are real problems, not a reason to fall back to defaults.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw new Error(
            `Cannot read ${configPath}: ${(error as Error).message}. Fix the file or its permissions.`,
        );
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
    // Settings saved under an alias (config set gemini.apiKey) were invisible
    // once the name resolved to its canonical form.
    const aliasNames = Object.entries(providerAliases())
        .filter(([alias, canonical]) => canonical === providerName && alias !== providerName)
        .map(([alias]) => alias);
    const fromFile = {
        ...Object.assign({}, ...aliasNames.map((alias) => config.providers?.[alias] ?? {})),
        ...(config.providers?.[providerName] ?? {}),
    };
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

/**
 * The starter file holds nothing but the shape. Pre-filling every provider and
 * every default looked helpful and was not: it buried the one real decision in
 * placeholders, and writing today's defaults into the file freezes them, so a
 * later change to a default model would be silently overridden by this copy.
 */
export const CONFIG_TEMPLATE: ModlensConfig = {
    // Empty means the built-in default provider.
    provider: '',
    providers: {},
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

/**
 * Render the effective config: the file merged with environment variables, with
 * API keys masked and every value tagged with where it came from (file or env).
 *
 * Reading only the file misled anyone who set a key through GEMINI_API_KEY (or
 * the other bound vars): the value modlens actually uses never showed up.
 */
export function renderEffectiveConfig(
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const providerNames = new Set<string>(Object.keys(config.providers ?? {}));
    for (const [providerName, bindings] of Object.entries(ENV_BINDINGS)) {
        if (Object.values(bindings).some((envName) => env[envName]?.trim())) {
            providerNames.add(providerName);
        }
    }

    const providers: Record<string, Record<string, string>> = {};
    for (const name of [...providerNames].sort()) {
        const fileSettings = config.providers?.[name] ?? {};
        const bindings = ENV_BINDINGS[name] ?? {};
        const fields: Record<string, string> = {};
        for (const field of ['apiKey', 'baseUrl', 'model'] as const) {
            const envName = bindings[field];
            const envValue = envName ? env[envName]?.trim() : undefined;
            const value = envValue ?? fileSettings[field];
            const source = envValue ? 'env' : fileSettings[field] !== undefined ? 'file' : null;
            if (value !== undefined && source) {
                const shown = field === 'apiKey' ? maskKey(value) : value;
                fields[field] = `${shown} (${source})`;
            }
        }
        if (Object.keys(fields).length > 0) {
            providers[name] = fields;
        }
    }

    const effective: { provider?: string; providers: Record<string, Record<string, string>> } = {
        providers,
    };
    if (config.provider?.trim()) {
        effective.provider = config.provider.trim();
    }
    return JSON.stringify(effective, null, 2);
}

function maskKey(key: string): string {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
}
