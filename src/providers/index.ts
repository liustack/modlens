import type { ProviderSettings } from '../config.ts';
import { antigravityCliProvider } from './antigravity.ts';
import { anthropicApiProvider } from './anthropicApi.ts';
import { claudeCliProvider } from './claudeCli.ts';
import { geminiApiProvider } from './geminiApi.ts';
import { openaiCompatProvider } from './openaiCompat.ts';

export interface ProviderInvocation {
    command: string;
    args: string[];
    cwd: string;
}

export interface BuildProviderInvocationOptions {
    imageSource: string;
    imageKind: 'local' | 'remote';
    model?: string;
    extraPrompt?: string;
    providerBin?: string;
    workdir?: string;
    timeoutMs: number;
    settings?: ProviderSettings;
}

export interface ProviderParsedOutput {
    result: unknown;
    meta: {
        conversationId: string | null;
        durationSeconds: number | null;
        usage: unknown | null;
    };
}

/** Everything a provider needs to explain a non-zero exit. */
export interface ProviderFailureContext {
    stdout: string;
    stderr: string;
    code: number | null;
}

export interface VisionProvider {
    name: string;
    defaultModel: string;
    // Subprocess providers implement buildInvocation + parseOutput.
    // In-process API providers implement execute instead.
    buildInvocation?: (options: BuildProviderInvocationOptions) => ProviderInvocation;
    parseOutput?: (stdout: string) => ProviderParsedOutput;
    execute?: (options: BuildProviderInvocationOptions) => Promise<ProviderParsedOutput>;
    /** Turn a non-zero exit into an actionable message, or null to use the default. */
    describeFailure?: (context: ProviderFailureContext) => string | null;
}

const PROVIDERS: Record<string, VisionProvider> = {
    'antigravity-cli': antigravityCliProvider,
    antigravity: antigravityCliProvider,
    agy: antigravityCliProvider,
    'gemini-api': geminiApiProvider,
    gemini: geminiApiProvider,
    openai: openaiCompatProvider,
    'openai-compat': openaiCompatProvider,
    anthropic: anthropicApiProvider,
    claude: anthropicApiProvider,
    'claude-cli': claudeCliProvider,
    'claude-code': claudeCliProvider,
};

export function resolveProvider(providerName = 'antigravity-cli'): VisionProvider {
    const normalized = providerName.trim().toLowerCase();
    const provider = PROVIDERS[normalized];

    if (!provider) {
        throw new Error(
            `Unsupported provider: ${providerName}. Available: ${listProviders().join(', ')}`,
        );
    }

    return provider;
}

export function listProviders(): string[] {
    return [...new Set(Object.values(PROVIDERS).map((provider) => provider.name))];
}
