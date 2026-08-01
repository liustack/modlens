import { antigravityCliProvider } from './antigravity.ts';

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
}

export interface ProviderParsedOutput {
    result: unknown;
    meta: {
        conversationId: string | null;
        durationSeconds: number | null;
        usage: unknown | null;
    };
}

export interface VisionProvider {
    name: string;
    defaultModel: string;
    buildInvocation: (options: BuildProviderInvocationOptions) => ProviderInvocation;
    parseOutput: (stdout: string) => ProviderParsedOutput;
}

const PROVIDERS: Record<string, VisionProvider> = {
    'antigravity-cli': antigravityCliProvider,
    antigravity: antigravityCliProvider,
    agy: antigravityCliProvider,
};

export function resolveProvider(providerName = 'antigravity-cli'): VisionProvider {
    const normalized = providerName.trim().toLowerCase();
    const provider = PROVIDERS[normalized];

    if (!provider) {
        throw new Error(`Unsupported provider: ${providerName}`);
    }

    return provider;
}

export function listProviders(): string[] {
    return [...new Set(Object.values(PROVIDERS).map((provider) => provider.name))];
}
