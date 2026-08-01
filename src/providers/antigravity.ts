import * as path from 'path';
import { buildVisionPrompt } from '../prompt.ts';
import { visionResultSchemaJson } from '../schema.ts';
import type {
    BuildProviderInvocationOptions,
    ProviderInvocation,
    ProviderParsedOutput,
    VisionProvider,
} from './index.ts';

export const DEFAULT_MODEL = 'gemini-3.6-flash-low';

interface AgyPrintEnvelope {
    conversation_id?: string;
    status?: string;
    response?: string;
    structured_output?: unknown;
    duration_seconds?: number;
    usage?: unknown;
    [key: string]: unknown;
}

export function buildAntigravityInvocation(
    options: BuildProviderInvocationOptions,
): ProviderInvocation {
    const prompt = buildVisionPrompt({
        imageSource: options.imageSource,
        imageKind: options.imageKind,
        extraPrompt: options.extraPrompt,
    });

    const printTimeout = `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`;

    const args = [
        '-p',
        prompt,
        // Without this, print mode silently skips tool calls and the agent
        // never reads the image.
        '--dangerously-skip-permissions',
        '--output-format',
        'json',
        '--json-schema',
        visionResultSchemaJson(),
        '--model',
        options.model || DEFAULT_MODEL,
        '--print-timeout',
        printTimeout,
    ];

    const cwd =
        options.workdir ||
        (options.imageKind === 'local' ? path.dirname(options.imageSource) : process.cwd());

    return {
        command: options.providerBin || 'agy',
        args,
        cwd: path.resolve(cwd),
    };
}

export function parseAntigravityOutput(stdout: string): ProviderParsedOutput {
    const envelope = parseEnvelope(stdout);

    if (envelope.status && envelope.status !== 'SUCCESS') {
        throw new Error(`Antigravity CLI reported status ${envelope.status}.`);
    }

    const result =
        envelope.structured_output ??
        (typeof envelope.response === 'string' ? tryParseJson(envelope.response) : null);

    if (result === null || result === undefined) {
        throw new Error(
            'Antigravity CLI output contains no structured result. Check that the model finished the task (auth, quota, timeout).',
        );
    }

    return {
        result,
        meta: {
            conversationId: envelope.conversation_id ?? null,
            durationSeconds: envelope.duration_seconds ?? null,
            usage: envelope.usage ?? null,
        },
    };
}

function parseEnvelope(stdout: string): AgyPrintEnvelope {
    const trimmed = stdout.trim();
    let parsed = tryParseJson(trimmed);

    if (parsed === null) {
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            parsed = tryParseJson(trimmed.slice(firstBrace, lastBrace + 1));
        }
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Failed to parse Antigravity CLI JSON output.');
    }

    return parsed as AgyPrintEnvelope;
}

function tryParseJson(text: string): unknown | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export const antigravityCliProvider: VisionProvider = {
    name: 'antigravity-cli',
    defaultModel: DEFAULT_MODEL,
    buildInvocation: buildAntigravityInvocation,
    parseOutput: parseAntigravityOutput,
};
