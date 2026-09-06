import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GuardsConfig } from './guard/rules.ts';
import { listProviders, providerAliases, resolveProvider } from './providers/index.ts';
import { splitApiKeys } from './util/apiKeys.ts';
import { parseExtraBody } from './util/extraBody.ts';
import { parseJsonOrExplain } from './util/json.ts';
import { maskUrlCredentials, redactSecrets } from './util/redact.ts';

// Layered configuration: CLI flags > environment variables > ~/.modlens/config.json > built-ins.

export interface ProviderSettings {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /**
     * Proxy route for this provider's API requests. Absent inherits the
     * top-level `proxy` and then HTTPS_PROXY/HTTP_PROXY. An empty string means
     * direct connection, and a non-empty string is a provider-specific proxy
     * URL (#20, #97). Never applies to the SSRF-guarded remote-image download
     * path.
     */
    proxy?: string;
    /**
     * Vendor-specific fields merged into the request body of the API providers
     * (turning thinking off is the usual reason). Not a string like the rest,
     * so the string-only fields have their own type below.
     */
    extraBody?: Record<string, unknown>;
    /**
     * Ask an OpenAI-compatible gateway to enforce the vision contract itself,
     * by sending it as `response_format: json_schema` (issue #37). Off by
     * default: an endpoint that does not support the field answers 400, and
     * the prompt template is what carries the contract everywhere else.
     */
    structuredOutput?: boolean;
}

/** The settings that hold a plain string, the only ones env vars can bind to. */
export type ProviderStringField = 'apiKey' | 'baseUrl' | 'model' | 'proxy';

const STRING_FIELDS: ProviderStringField[] = ['apiKey', 'baseUrl', 'model', 'proxy'];

/** Harnesses whose local logins modlens can be granted to borrow. */
export const REUSE_HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'grok'] as const;
export type ReuseHarness = (typeof REUSE_HARNESSES)[number];

export interface ModlensConfig {
    provider?: string;
    /** Default proxy URL for all API providers (see ProviderSettings.proxy). */
    proxy?: string;
    providers?: Record<string, ProviderSettings>;
    /** Invocation guard: when the active model already sees images, skip the engine. */
    guards?: GuardsConfig;
    /**
     * Per-harness borrow decisions, written by the onboarding conversation:
     * true = the user allowed borrowing this harness's login for reads,
     * false = they refused (do not ask again), absent = never asked.
     * `claude` absent counts as granted for compatibility: claude-cli predates
     * this model as a built-in provider.
     */
    reuse?: Partial<Record<ReuseHarness, boolean>>;
    /**
     * Named saved copies of one provider slot's file settings, keyed by slot
     * then by a user-chosen label (issue #67). Inert data: nothing in
     * resolution, guards, failover, or env binding reads it. Only `config
     * save` and `config use` write it, and only the openai slot is accepted,
     * because it is the one slot users point at many different gateways.
     */
    saved?: Record<string, Record<string, ProviderSettings>>;
    /**
     * Quota cooldown switch: 'on' (default) or 'off'. On, a quota-spent
     * provider is remembered and moved to the back of the fallback chain until
     * it recovers. Off, nothing is read from or written to state.json and
     * routing is unchanged.
     */
    cooldown?: string;
}

export const CONFIG_DIR = path.join(os.homedir(), '.modlens');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// A provider's settings come from one place, whole (issue #42). A baseUrl and
// an apiKey are one credential, and drawing halves from two sources builds a
// pairing that exists in neither: an ambient OPENAI_API_KEY set for another
// tool used to replace the key beside a configured endpoint, and the run
// answered 401 with nothing naming the environment as the source. Merging the
// other way round would keep the same shape, so the rule is not about which
// side wins a field: mention a provider in the config file and the file is its
// source, mention nothing and the environment is, which keeps a container that
// only exports variables working with both halves still matching.
const ENV_BINDINGS: Record<string, Partial<Record<ProviderStringField, string>>> = {
    'gemini-api': { apiKey: 'GEMINI_API_KEY', baseUrl: 'GEMINI_BASE_URL' },
    openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
};

/**
 * Every key under `providers` that names this one, its aliases included.
 *
 * Presence of the key is what counts, not whether it holds anything: clearing
 * the last field of an entry leaves `{}` behind, and reading that as "the file
 * says nothing" would hand the provider back to the environment variables the
 * entry was there to displace.
 */
function fileKeysFor(providerName: string, config: ModlensConfig): string[] {
    return Object.keys(isPlainObject(config.providers) ? config.providers : {}).filter(
        (key) => foldProviderName(key) === providerName,
    );
}

/** Everything the file holds for one provider, its aliases included. */
function fileSettingsFor(providerName: string, config: ModlensConfig): ProviderSettings {
    const keys = fileKeysFor(providerName, config);
    // The canonical key is merged last so it wins over an alias holding the
    // same field.
    const ordered = [
        ...keys.filter((key) => key !== providerName),
        ...keys.filter((key) => key === providerName),
    ];
    return Object.assign(
        {},
        ...ordered.map((key) => {
            const entry = config.providers?.[key];
            // A hand edit can make an entry any shape; a string spread here
            // used to turn into per-character keys downstream.
            return isPlainObject(entry) ? entry : {};
        }),
    );
}

/** What the environment holds for one provider, through its bound variables. */
function envSettingsFor(providerName: string, env: NodeJS.ProcessEnv): ProviderSettings {
    const settings: ProviderSettings = {};
    for (const [field, variable] of Object.entries(ENV_BINDINGS[providerName] ?? {}) as Array<
        [ProviderStringField, string]
    >) {
        const value = env[variable]?.trim();
        const present = field === 'apiKey' ? splitApiKeys(value).length > 0 : Boolean(value);
        if (value && present) {
            settings[field] = value;
        }
    }
    return settings;
}

/**
 * The endpoint variables that stop applying the moment the config file names
 * their provider. Someone who routed a gateway through `ANTHROPIC_BASE_URL`
 * and then set `anthropic.apiKey` in the file has, from 3.17.0, a file-sourced
 * provider with no endpoint, and would otherwise have that gateway's key, and
 * the image beside it, delivered to Anthropic's own endpoint. The check fires
 * only in exactly that case: variable set, provider named by the file, no
 * baseUrl there.
 */
const ENDPOINT_BINDINGS: Record<string, { variable: string; consequence: string }> = {
    // No default endpoint, so the run cannot misroute: it simply has nowhere
    // to go, and saying otherwise would invent a danger to justify the error.
    openai: {
        variable: 'OPENAI_BASE_URL',
        consequence: 'this run has no endpoint left to send the image to',
    },
    anthropic: {
        variable: 'ANTHROPIC_BASE_URL',
        consequence: "this run would have sent your key and the image to Anthropic's own endpoint",
    },
};

export function assertNoRetiredEndpointBinding(
    providerName: string,
    settings: ProviderSettings,
    env: NodeJS.ProcessEnv = process.env,
): void {
    const binding = ENDPOINT_BINDINGS[providerName];
    const variable = binding?.variable;
    if (!variable || settings.baseUrl?.trim() || !env[variable]?.trim()) {
        return;
    }
    // The command names the variable rather than its value: the shell expands
    // it, so the migration stays one paste away without the message carrying
    // an endpoint that may hold userinfo. A masked copy identifies which one
    // is meant, since errors travel into logs and screenshots. The spelling
    // follows the platform, because a POSIX form is not runnable where most
    // of the people this affects are (issue #42 came from Windows).
    const shown = maskUrlCredentials(env[variable]?.trim() ?? '');
    const reference = process.platform === 'win32' ? `$env:${variable}` : `"$${variable}"`;
    throw new Error(
        `${variable} is set (${shown}), but the config file configures ${providerName}, and since 3.17.0 a provider takes its settings from one place: the file, whole. ${providerName}.baseUrl is not in it, so ${binding.consequence}. To keep the endpoint you were using, run: modlens config set ${providerName}.baseUrl ${reference}`,
    );
}

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

/** Whether the quota cooldown is active. On by default, off only when set to 'off'. */
export function cooldownEnabled(config: ModlensConfig): boolean {
    return config.cooldown?.trim().toLowerCase() !== 'off';
}

/**
 * The canonical name for a provider, folding aliases (agy, gemini, ...).
 * Own properties only: the aliases table is a plain object, and a bare index
 * walks the prototype chain.
 */
export function canonicalProviderName(name: string): string {
    const trimmed = name.trim().toLowerCase();
    return foldProviderName(trimmed);
}

/**
 * Whether the config file names this provider, aliases included. An entry
 * holding nothing still counts: see fileKeysFor.
 */
export function providerConfiguredInFile(providerName: string, config: ModlensConfig): boolean {
    return fileKeysFor(providerName, config).length > 0;
}

export function resolveProviderSettings(
    providerName: string,
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): ProviderSettings {
    // Settings saved under an alias (config set gemini.apiKey) count as the
    // file naming this provider: they were invisible once the name resolved to
    // its canonical form.
    const mentioned = providerConfiguredInFile(providerName, config);
    const settings: ProviderSettings = mentioned
        ? { ...fileSettingsFor(providerName, config) }
        : envSettingsFor(providerName, env);
    // The top-level proxy is the default only while this provider leaves the
    // field absent. An explicit empty string means direct connection, which is
    // distinct from inheriting the machine-wide route (#97).
    if (
        !Object.hasOwn(settings, 'proxy') &&
        typeof config.proxy === 'string' &&
        config.proxy.trim()
    ) {
        settings.proxy = config.proxy.trim();
    }
    return settings;
}

/** Set a dotted key like "gemini-api.apiKey" or "provider" and persist with 0600 perms. */
export function setConfigValue(dottedKey: string, value: string, configPath = CONFIG_PATH): void {
    const config = loadConfigFile(configPath);

    if (dottedKey === 'provider') {
        config.provider = value;
    } else if (dottedKey === 'cooldown') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== 'on' && normalized !== 'off') {
            throw new Error(`Invalid cooldown value: ${value}. Use on or off.`);
        }
        config.cooldown = normalized;
    } else if (dottedKey === 'proxy') {
        if (value.trim() === '') {
            delete config.proxy;
        } else {
            config.proxy = value.trim();
        }
    } else if (dottedKey.startsWith('reuse.')) {
        const harness = dottedKey.slice('reuse.'.length);
        if (!(REUSE_HARNESSES as readonly string[]).includes(harness)) {
            throw new Error(
                `Unknown reuse harness: ${harness}. Use ${REUSE_HARNESSES.join(', ')}.`,
            );
        }
        const key = harness as ReuseHarness;
        const normalized = value.trim().toLowerCase();
        if (normalized === '') {
            delete config.reuse?.[key];
            if (config.reuse && Object.keys(config.reuse).length === 0) {
                delete config.reuse;
            }
        } else if (normalized !== 'true' && normalized !== 'false') {
            throw new Error(`reuse.${harness} must be true or false (empty clears).`);
        } else {
            config.reuse ??= {};
            config.reuse[key] = normalized === 'true';
        }
    } else if (dottedKey.startsWith('guards.')) {
        setGuardsValue(config, dottedKey.slice('guards.'.length), value);
    } else {
        const dot = dottedKey.indexOf('.');
        if (dot <= 0 || dot === dottedKey.length - 1) {
            throw new Error(
                `Invalid config key: ${dottedKey}. Use "provider", "proxy", "cooldown", "reuse.<claude|codex|opencode|pi|grok>", "guards.<denyModels|allowModels|denyWhenUnknown>", or "<provider>.<apiKey|baseUrl|model|proxy|extraBody|structuredOutput>".`,
            );
        }
        const typedName = dottedKey.slice(0, dot);
        const field = dottedKey.slice(dot + 1);
        // The file is read back by exact lowercase key, so a mis-cased or
        // unknown name here would be saved, reported as saved, and silently
        // never read, while the environment quietly kept answering for the
        // provider the user thought they had just configured. Fold the case
        // the way -p does, and refuse a name no provider answers to.
        const providerName = typedName.trim().toLowerCase();
        if (config.providers !== undefined && !isPlainObject(config.providers)) {
            throw new Error(
                `The "providers" section in ${configPath} is not an object. Fix or remove it, then try again.`,
            );
        }
        // Every spelling that folds onto this provider, not just the one the
        // user typed: a malformed openai-compat entry beside a healthy openai
        // one used to be reachable by writing under the other name.
        for (const spelling of fileKeysFor(foldProviderName(providerName), config)) {
            const entry = config.providers?.[spelling];
            if (entry !== undefined && !isPlainObject(entry)) {
                throw new Error(
                    `"providers.${spelling}" in ${configPath} is not an object. Fix or remove it, then try again.`,
                );
            }
        }
        try {
            resolveProvider(providerName);
        } catch {
            throw new Error(
                `Unknown provider: ${typedName}. Use one of ${listProviders().join(', ')} (aliases like ${Object.keys(
                    providerAliases(),
                )
                    .filter((alias) => providerAliases()[alias] !== alias)
                    .slice(0, 4)
                    .join(', ')} work too).`,
            );
        }
        if (field === 'structuredOutput') {
            // Only the openai route reads it, so accepting it anywhere else
            // would report a saved setting that never does anything.
            if (foldProviderName(providerName) !== 'openai') {
                throw new Error(
                    `structuredOutput applies to the openai provider only, not ${providerName}.`,
                );
            }
            const normalized = value.trim().toLowerCase();
            if (normalized !== '' && normalized !== 'true' && normalized !== 'false') {
                throw new Error(
                    `${providerName}.structuredOutput must be true or false (empty clears).`,
                );
            }
            config.providers ??= {};
            config.providers[providerName] ??= {};
            if (normalized === '') {
                delete config.providers[providerName].structuredOutput;
            } else {
                config.providers[providerName].structuredOutput = normalized === 'true';
            }
        } else if (field === 'extraBody') {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            // An empty value clears it, so a user who no longer wants the
            // passthrough does not have to hand-edit the file.
            if (value.trim() === '') {
                delete config.providers[providerName].extraBody;
            } else {
                config.providers[providerName].extraBody = parseExtraBody(
                    value,
                    `${providerName}.extraBody`,
                );
            }
        } else if (!STRING_FIELDS.includes(field as ProviderStringField)) {
            throw new Error(
                `Unknown config field: ${field}. Use apiKey, baseUrl, model, proxy, extraBody, or structuredOutput.`,
            );
        } else {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            config.providers[providerName][field as ProviderStringField] = value;
        }
    }

    persistConfig(config, configPath);
}

/** Write the config back with the 0600 permissions every write here uses. */
function persistConfig(config: ModlensConfig, configPath: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

/**
 * Fail fast, in a sentence, when a hand-edited config would otherwise crash a
 * run with a raw TypeError deep inside doctor or a read. `config show` stays
 * permissive on purpose, reporting the same shapes in place; this is the
 * boundary for the paths that EXECUTE the config rather than describe it.
 */
export function assertReadableConfig(config: ModlensConfig, configPath = CONFIG_PATH): void {
    const sentence = (path: string, what: string): Error =>
        new Error(`${path} in ${configPath} ${what}. Fix or remove it, then try again.`);
    if (config.provider !== undefined && typeof config.provider !== 'string') {
        throw sentence('"provider"', 'is not a string');
    }
    if (config.proxy !== undefined && typeof config.proxy !== 'string') {
        throw sentence('"proxy"', 'is not a string');
    }
    if (config.cooldown !== undefined && typeof config.cooldown !== 'string') {
        throw sentence('"cooldown"', 'is not a string');
    }
    if (config.reuse !== undefined && !isPlainObject(config.reuse)) {
        throw sentence('"reuse"', 'is not an object');
    }
    if (config.providers !== undefined && !isPlainObject(config.providers)) {
        throw sentence('"providers"', 'is not an object');
    }
    for (const [name, entry] of Object.entries(
        isPlainObject(config.providers) ? config.providers : {},
    )) {
        if (!isPlainObject(entry)) {
            throw sentence(`"providers.${name}"`, 'is not an object');
        }
        const offence = entryFieldOffence(entry);
        if (offence !== null) {
            throw sentence(`"providers.${name}"`, offence);
        }
    }
    if (config.saved !== undefined && !isPlainObject(config.saved)) {
        throw sentence('"saved"', 'is not an object');
    }
    if (config.guards !== undefined) {
        if (!isPlainObject(config.guards)) {
            throw sentence('"guards"', 'is not an object');
        }
        for (const field of ['denyModels', 'allowModels'] as const) {
            const value = (config.guards as Record<string, unknown>)[field];
            if (value !== undefined && !Array.isArray(value)) {
                throw sentence(`"guards.${field}"`, 'is not an array');
            }
        }
        const flag = (config.guards as Record<string, unknown>).denyWhenUnknown;
        if (flag !== undefined && typeof flag !== 'boolean') {
            throw sentence('"guards.denyWhenUnknown"', 'is not true or false');
        }
    }
}

/** bundleFieldOffence without the at-least-one rule: live entries may be partial. */
function entryFieldOffence(entry: Record<string, unknown>): string | null {
    for (const field of ['apiKey', 'baseUrl', 'model', 'proxy'] as const) {
        if (entry[field] !== undefined && typeof entry[field] !== 'string') {
            return `has a non-string ${field}`;
        }
    }
    if (entry.extraBody !== undefined && !isPlainObject(entry.extraBody)) {
        return 'has an extraBody that is not an object';
    }
    if (entry.structuredOutput !== undefined && typeof entry.structuredOutput !== 'boolean') {
        return 'has a structuredOutput that is not true or false';
    }
    return null;
}

/**
 * Redact every known key from a value tree's strings, longest key first so an
 * overlapping shorter key cannot split a longer one into survivable halves.
 * No length assumption at all: the config layer imposes no minimum on an
 * apiKey and gateways issue what they issue, so even a one-character key is
 * scrubbed from every string it appears in. A short key shreds the view's
 * readability, and that is the right failure: this output exists to be
 * pasted into issues, and a shredded view is safe where a readable one
 * leaking a credential is not.
 *
 * Values ONLY, by structural contract: every property name in the rendered
 * view is a compile-time constant or a registry provider name, and all user
 * data (labels, slot names, hand-written spellings) lives inside values. Two
 * earlier designs put user data in property names, and each grew its own
 * leak: a saved label could BE the key, and the dedupe suffix for collided
 * names could itself reassemble one. Names that never carry user data need
 * no scrubbing and cannot collide.
 */
function redactValues<T>(value: T, keys: string[]): T {
    const ordered = [...keys].sort((a, b) => b.length - a.length);
    const scrub = (text: string): string => {
        let out = text;
        for (const key of ordered) {
            if (key.length > 0) {
                out = out.split(key).join('[redacted]');
            }
        }
        return out;
    };
    const walk = (node: unknown): unknown => {
        if (typeof node === 'string') return scrub(node);
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
            const out: Record<string, unknown> = Object.create(null);
            for (const [key, entry] of Object.entries(node)) {
                out[key] = walk(entry);
            }
            return out;
        }
        return node;
    };
    return walk(value) as T;
}

/** Every API key the file or environment holds, active rows and saved copies. */
export function knownApiKeys(
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const keys = new Set<string>();
    const providersRoot = isPlainObject(config.providers) ? config.providers : {};
    for (const entry of Object.values(providersRoot)) {
        if (isPlainObject(entry) && typeof entry.apiKey === 'string') {
            for (const apiKey of splitApiKeys(entry.apiKey)) {
                keys.add(apiKey);
            }
        }
    }
    for (const bindings of Object.values(ENV_BINDINGS)) {
        const variable = (bindings as Partial<Record<ProviderStringField, string>>).apiKey;
        for (const apiKey of splitApiKeys(variable ? env[variable] : undefined)) {
            keys.add(apiKey);
        }
    }
    const savedRoot = isPlainObject(config.saved) ? config.saved : {};
    for (const bundles of Object.values(savedRoot)) {
        if (!isPlainObject(bundles)) continue;
        for (const bundle of Object.values(bundles)) {
            if (isPlainObject(bundle) && typeof bundle.apiKey === 'string') {
                for (const apiKey of splitApiKeys(bundle.apiKey)) {
                    keys.add(apiKey);
                }
            }
        }
    }
    return [...keys];
}

/**
 * The first way a bundle's KNOWN fields violate the slot contract, or null.
 * Field types mirror ProviderSettings; fields this version does not know are
 * left alone on purpose (a newer version may have written them).
 */
function bundleFieldOffence(bundle: Record<string, unknown>): string | null {
    const offence = entryFieldOffence(bundle);
    if (offence !== null) {
        return offence;
    }
    const KNOWN = ['apiKey', 'baseUrl', 'model', 'proxy', 'extraBody', 'structuredOutput'];
    if (!KNOWN.some((field) => bundle[field] !== undefined)) {
        return 'holds none of the openai fields, so using it would empty the slot';
    }
    return null;
}

/**
 * Alias-fold a provider name through own properties only. The aliases table
 * is a plain object, and a bare index walks the prototype chain: the name
 * "constructor" resolved to Object's constructor, read as truthy, and a
 * `config set constructor.apiKey` wrote the key onto that global function,
 * printed success, and saved nothing.
 */
function foldProviderName(name: string): string {
    const aliases = providerAliases();
    return Object.hasOwn(aliases, name) ? aliases[name] : name;
}

const SAVED_LABEL = /^[a-z][a-z0-9-]*$/;

/**
 * JSON-parsed objects only: null, arrays, strings, and anything living on a
 * prototype are not bundles. The saved section is hand-editable, and `use`
 * once accepted `constructor` as a label because bracket lookup walks the
 * prototype chain: Object's constructor came back, spread into `{}`, and an
 * unsaved key died under a success message.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep equality over JSON-shaped data; the `use` refusal rests on it. */
function deepEqualJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => deepEqualJson(item, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a as object).sort();
        const kb = Object.keys(b as object).sort();
        return (
            ka.length === kb.length &&
            ka.every(
                (key, i) =>
                    key === kb[i] &&
                    deepEqualJson(
                        (a as Record<string, unknown>)[key],
                        (b as Record<string, unknown>)[key],
                    ),
            )
        );
    }
    return false;
}

/** The one slot `save`/`use` accept, with alias spellings folded onto it. */
function savedSlotFor(slot: string): string {
    const folded = slot.trim().toLowerCase();
    const canonical = foldProviderName(folded);
    if (canonical !== 'openai') {
        throw new Error(
            `Saved copies exist only for the openai slot, the one slot users point at many different gateways. "${slot}" has none.`,
        );
    }
    return canonical;
}

/**
 * Snapshot the openai slot's file settings under a label (issue #67).
 * Switching gateways used to overwrite providers.openai and lose the previous
 * key; a saved copy is where it survives.
 */
export function saveProviderBundle(slot: string, label: string, configPath = CONFIG_PATH): boolean {
    const canonical = savedSlotFor(slot);
    if (!SAVED_LABEL.test(label)) {
        throw new Error(
            `Labels are lowercase letters, digits and hyphens, starting with a letter: "${label}" is not.`,
        );
    }
    const config = loadConfigFile(configPath);
    const snapshot = fileSettingsFor(canonical, config);
    if (Object.keys(snapshot).length === 0) {
        throw new Error(
            `Nothing to save: the ${canonical} slot is empty in ${configPath}. Configure it first (modlens config set openai.baseUrl <url>).`,
        );
    }
    if (config.saved !== undefined && !isPlainObject(config.saved)) {
        throw new Error(
            `The "saved" section in ${configPath} is not an object. Fix or remove it, then save again.`,
        );
    }
    config.saved ??= {};
    if (config.saved[canonical] !== undefined && !isPlainObject(config.saved[canonical])) {
        throw new Error(
            `"saved.${canonical}" in ${configPath} is not an object. Fix or remove it, then save again.`,
        );
    }
    config.saved[canonical] ??= {};
    const replaced = Object.hasOwn(config.saved[canonical], label);
    config.saved[canonical][label] = snapshot;
    persistConfig(config, configPath);
    return replaced;
}

/**
 * Replace the openai slot with a saved copy, whole (issue #67). A merge would
 * build an endpoint nobody configured, so the bundle swaps in as one piece.
 * An active slot that is not saved under any label refuses to be overwritten:
 * losing a key silently is the failure this feature exists to remove, so it
 * can only happen when `discard` says so in as many words.
 */
export function useProviderBundle(
    slot: string,
    label: string,
    discard = false,
    configPath = CONFIG_PATH,
): void {
    const canonical = savedSlotFor(slot);
    const config = loadConfigFile(configPath);
    if (config.providers !== undefined && !isPlainObject(config.providers)) {
        throw new Error(
            `The "providers" section in ${configPath} is not an object. Fix or remove it, then try again.`,
        );
    }
    // A malformed saved section refuses here the same way save refuses it:
    // reading it as empty told the user to save first, which was the wrong
    // story about their file.
    if (config.saved !== undefined && !isPlainObject(config.saved)) {
        throw new Error(
            `The "saved" section in ${configPath} is not an object. Fix or remove it, then try again.`,
        );
    }
    if (config.saved?.[canonical] !== undefined && !isPlainObject(config.saved[canonical])) {
        throw new Error(
            `"saved.${canonical}" in ${configPath} is not an object. Fix or remove it, then try again.`,
        );
    }
    // Own properties only: bracket lookup walks the prototype chain, and the
    // label "constructor" passed the regex, found Object's constructor, and
    // emptied the slot under a success message.
    const bundles = config.saved?.[canonical] ?? {};
    const known = Object.keys(bundles).sort();
    if (!Object.hasOwn(bundles, label)) {
        throw new Error(
            known.length === 0
                ? `No saved copies exist for ${canonical} yet. Save the current one first: modlens config save openai <label>.`
                : `No saved copy named "${label}". Saved: ${known.join(', ')}.`,
        );
    }
    const bundle = bundles[label];
    if (!isPlainObject(bundle)) {
        throw new Error(
            `The saved copy "${label}" in ${configPath} is not an object (found ${
                bundle === null ? 'null' : Array.isArray(bundle) ? 'an array' : typeof bundle
            }). Fix or remove it under "saved.${canonical}.${label}", then try again.`,
        );
    }
    // The object shell is not the contract. A hand-edited bundle used to
    // promote any field type into the active slot, where config show then
    // crashed on the first non-string apiKey; and a bundle holding none of
    // the slot's fields emptied the slot the way the fixed P1 did. Unknown
    // extra fields stay legal, or a bundle saved by a newer version could
    // not be used by this one.
    const offence = bundleFieldOffence(bundle);
    if (offence !== null) {
        throw new Error(
            `The saved copy "${label}" in ${configPath} ${offence}. Fix it under "saved.${canonical}.${label}", then try again.`,
        );
    }
    const current = fileSettingsFor(canonical, config);
    const currentSaved =
        Object.keys(current).length === 0 ||
        Object.values(bundles).some((entry) => deepEqualJson(entry, current));
    if (!currentSaved && !discard) {
        throw new Error(
            `The current ${canonical} settings are not saved under any label and would be lost. Save them first (modlens config save openai <label>) or pass --discard.`,
        );
    }
    // Every alias spelling goes, or an old section under openai-compat would
    // keep merging into reads beside the bundle that just swapped in.
    for (const key of fileKeysFor(canonical, config)) {
        delete config.providers?.[key];
    }
    config.providers ??= {};
    config.providers[canonical] = { ...bundle };
    persistConfig(config, configPath);
}

/** Accepts a JSON array of globs or a comma-separated list. Empty clears. */
function setGuardsValue(config: ModlensConfig, field: string, value: string): void {
    if (config.guards !== undefined && !isPlainObject(config.guards)) {
        throw new Error(
            'The "guards" section in the config file is not an object. Fix or remove it, then try again.',
        );
    }
    if (field === 'denyModels' || field === 'allowModels') {
        if (value.trim() === '') {
            delete config.guards?.[field];
        } else {
            config.guards ??= {};
            config.guards[field] = parseModelList(value, `guards.${field}`);
        }
    } else if (field === 'denyWhenUnknown') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
            throw new Error('guards.denyWhenUnknown must be true or false.');
        }
        config.guards ??= {};
        config.guards.denyWhenUnknown = normalized === 'true';
    } else {
        throw new Error(
            `Unknown guards field: ${field}. Use denyModels, allowModels, or denyWhenUnknown.`,
        );
    }
    if (config.guards && Object.keys(config.guards).length === 0) {
        delete config.guards;
    }
}

function parseModelList(value: string, key: string): string[] {
    if (value.trim().startsWith('[')) {
        const parsed = parseJsonOrExplain(value, key);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            throw new Error(`${key} must be a JSON array of glob strings.`);
        }
        return parsed as string[];
    }
    return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
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
        throw new Error(
            `${configPath} already exists. Use --force to overwrite (that also deletes every saved gateway copy under "saved").`,
        );
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
 * Render the effective config, with API keys masked and every value tagged with
 * the source it actually came from.
 *
 * One row per provider under its canonical name, whichever key the file used:
 * an entry saved as `gemini` and a `GEMINI_API_KEY` beside it are one provider,
 * and printing them as two rows would show a value the run never reads (issue
 * #42).
 */
export function renderEffectiveConfig(
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const providersRoot = isPlainObject(config.providers) ? config.providers : undefined;
    const canonicalNames = new Set(listProviders());
    const providerNames = new Set<string>(
        Object.keys(providersRoot ?? {})
            .map((key) => foldProviderName(key))
            .filter((name) => canonicalNames.has(name)),
    );
    // A provider configured only through the environment is still in effect,
    // so it belongs in a view of what is in effect.
    for (const [providerName, bindings] of Object.entries(ENV_BINDINGS)) {
        if (
            (Object.entries(bindings) as Array<[ProviderStringField, string]>).some(
                ([field, variable]) => {
                    const value = env[variable]?.trim();
                    return field === 'apiKey' ? splitApiKeys(value).length > 0 : Boolean(value);
                },
            )
        ) {
            providerNames.add(providerName);
        }
    }

    const providers: Record<string, Record<string, string>> = Object.create(null);
    // Every property name in this view is a constant or a registry provider
    // name; user-written spellings only ever appear inside note VALUES, where
    // the redaction boundary covers them. Two designs that keyed rows by user
    // data each grew a credential leak through the names.
    const notes: string[] = [];
    for (const [rawName, entry] of Object.entries(providersRoot ?? {})) {
        if (entry !== undefined && !isPlainObject(entry)) {
            notes.push(`providers.${rawName} is not an object; fix or remove it`);
            continue;
        }
        if (!canonicalNames.has(foldProviderName(rawName))) {
            notes.push(`providers.${rawName} is not a known provider; runs ignore it`);
        }
    }
    if (config.providers !== undefined && providersRoot === undefined) {
        providers['(malformed)'] = {
            providers: 'the "providers" section is not an object; fix or remove it',
        };
    }
    for (const name of [...providerNames].sort()) {
        const fileSettings = fileSettingsFor(name, config);
        // Whichever source is actually in effect for this provider, labelled
        // as such: the view has to agree with what a run would use.
        const mentioned = providerConfiguredInFile(name, config);
        const effective = mentioned ? fileSettings : envSettingsFor(name, env);
        const source: 'file' | 'env' = mentioned ? 'file' : 'env';
        const fields: Record<string, string> = {};
        // The whole row shares one display boundary: every shown string is
        // redacted against this entry's key, because a key that also rides in
        // a gateway URL or a model note used to print in full one field over
        // from its own mask.
        const entryKeys = splitApiKeys(
            typeof effective.apiKey === 'string' ? effective.apiKey : undefined,
        );
        const guard = (shown: string): string => redactSecrets(shown, entryKeys);
        for (const field of STRING_FIELDS) {
            const value = effective[field];
            if (value === undefined) {
                continue;
            }
            if (typeof value !== 'string') {
                // A hand edit can make any field any shape, and this view is
                // the diagnostic surface: report it, never crash on it.
                fields[field] = `(malformed: not a string) (${source})`;
                continue;
            }
            // config show exists to be pasted into issues: keys are
            // masked, and a proxy URL's userinfo is a credential too.
            const shown =
                field === 'apiKey'
                    ? maskKeys(value)
                    : field === 'proxy'
                      ? value.trim() === ''
                          ? 'direct'
                          : maskUrlCredentials(guard(value))
                      : guard(value);
            fields[field] = `${shown} (${source})`;
        }
        // No env binding and no secret to mask, but it changes what gets sent,
        // so it belongs in the effective view.
        if (fileSettings.structuredOutput !== undefined) {
            fields.structuredOutput = `${fileSettings.structuredOutput} (file)`;
        }
        if (fileSettings.extraBody !== undefined) {
            fields.extraBody = `${guard(JSON.stringify(fileSettings.extraBody))} (file)`;
        }
        // An entry the file holds but has emptied still prints, as `{}`: it is
        // why the environment is not supplying this provider, so a view that
        // hid it would leave the silence unexplained.
        if (Object.keys(fields).length > 0 || mentioned) {
            providers[name] = fields;
        }
    }

    const effective: {
        provider?: string;
        proxy?: string;
        cooldown?: string;
        providers: Record<string, Record<string, string>>;
        saved?: string[];
        notes?: string[];
        guards?: Record<string, string>;
        reuse?: Record<string, string>;
    } = {
        providers,
        cooldown: config.cooldown ? `${config.cooldown} (file)` : 'on (default)',
    };
    // Saved copies are inert data, but they hold keys, so the view names
    // them the way it names everything secret: present, masked, never shown.
    // Every saved slot, label, and malformed note renders as one VALUE line:
    // user data never becomes a property name here, which is the structural
    // half of the redaction boundary (see redactValues).
    const savedRows: string[] = [];
    const savedRoot = config.saved;
    if (savedRoot !== undefined && !isPlainObject(savedRoot)) {
        savedRows.push('the "saved" section is not an object; fix or remove it');
    }
    for (const [slot, bundles] of Object.entries(isPlainObject(savedRoot) ? savedRoot : {})) {
        if (!isPlainObject(bundles)) {
            savedRows.push(`saved.${slot} is not an object; fix or remove it`);
            continue;
        }
        for (const label of Object.keys(bundles).sort()) {
            const bundle = bundles[label];
            if (!isPlainObject(bundle)) {
                savedRows.push(`${slot}/${label}: (malformed: not an object; fix or remove it)`);
                continue;
            }
            const parts = [
                typeof bundle.model === 'string' ? bundle.model : undefined,
                typeof bundle.baseUrl === 'string' ? bundle.baseUrl : undefined,
                bundle.apiKey === undefined
                    ? 'no key'
                    : typeof bundle.apiKey === 'string'
                      ? `key ${maskKeys(bundle.apiKey)}`
                      : 'key (malformed: not a string)',
            ].filter(Boolean);
            savedRows.push(`${slot}/${label}: ${parts.join(' @ ')}`);
        }
    }
    if (savedRows.length > 0) {
        effective.saved = savedRows;
    }
    if (typeof config.provider === 'string' && config.provider.trim()) {
        effective.provider = config.provider.trim();
    } else if (config.provider !== undefined && typeof config.provider !== 'string') {
        effective.provider = '(malformed: not a string)';
    }
    if (config.proxy !== undefined && typeof config.proxy !== 'string') {
        effective.proxy = '(malformed: not a string)';
    } else if (config.proxy?.trim()) {
        effective.proxy = `${maskUrlCredentials(config.proxy.trim())} (file)`;
    } else if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
        const raw = (env.HTTPS_PROXY ||
            env.https_proxy ||
            env.HTTP_PROXY ||
            env.http_proxy) as string;
        effective.proxy = `${maskUrlCredentials(raw)} (env)`;
    }
    if (config.guards !== undefined && !isPlainObject(config.guards)) {
        effective.guards = {
            '(malformed)': 'the "guards" section is not an object; fix or remove it',
        };
    } else if (config.guards) {
        const guards: Record<string, string> = {};
        if (config.guards.denyModels !== undefined) {
            guards.denyModels = `${JSON.stringify(config.guards.denyModels)} (file)`;
        }
        if (config.guards.allowModels !== undefined) {
            guards.allowModels = `${JSON.stringify(config.guards.allowModels)} (file)`;
        }
        if (config.guards.denyWhenUnknown !== undefined) {
            guards.denyWhenUnknown = `${config.guards.denyWhenUnknown} (file)`;
        }
        if (Object.keys(guards).length > 0) {
            effective.guards = guards;
        }
    }
    // The onboarding flow decides whether to ask by reading this view, so a
    // recorded refusal must be visible or the user gets re-asked forever.
    if (config.reuse !== undefined && !isPlainObject(config.reuse)) {
        effective.reuse = {
            '(malformed)': 'the "reuse" section is not an object; fix or remove it',
        };
    } else if (config.reuse && Object.keys(config.reuse).length > 0) {
        // Known harnesses only as keys; a hand-written stranger is reported
        // as a note VALUE, never as a property name.
        const reuse: Record<string, string> = {};
        for (const harness of REUSE_HARNESSES) {
            const granted = (config.reuse as Record<string, unknown>)[harness];
            if (granted !== undefined) {
                reuse[harness] = `${granted} (file)`;
            }
        }
        for (const stranger of Object.keys(config.reuse).filter(
            (key) => !(REUSE_HARNESSES as readonly string[]).includes(key),
        )) {
            notes.push(`reuse.${stranger} is not a known harness; runs ignore it`);
        }
        if (Object.keys(reuse).length > 0) {
            effective.reuse = reuse;
        }
    }
    // Attached LAST, after every producer has run: an earlier version hung
    // the array as soon as the provider pass filled it, and a stranger reuse
    // note pushed later was silently dropped whenever no earlier note had
    // created the attachment.
    if (notes.length > 0) {
        effective.notes = notes;
    }
    // The FINAL display boundary, applied to string VALUES before the JSON
    // is serialized. Per-field guards above keep the view readable; this pass
    // exists because chasing fields one by one is how the top-level proxy and
    // guards kept printing a key another field had just masked. Values only:
    // an earlier version replaced bytes in the finished text and a key that
    // collided with a property name broke the JSON itself. Keys come from the
    // same env this render was asked to describe.
    return JSON.stringify(redactValues(effective, knownApiKeys(config, env)), null, 2);
}

function maskKey(key: string): string {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
}

function maskKeys(value: string): string {
    const keys = splitApiKeys(value);
    return keys.length > 0 ? keys.map(maskKey).join(', ') : '****';
}
