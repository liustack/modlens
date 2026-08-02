// Claude Code CLI provider: rides an existing `claude` login, no API key.
// Permissions stay tight: only the Read tool is allowed, enough to view the
// image and nothing else. Structured output enforced via --json-schema.
import * as path from 'path';
import { buildVisionPrompt } from '../prompt.ts';
import { visionResultSchemaJson } from '../schema.ts';
import type {
    BuildProviderInvocationOptions,
    ProviderInvocation,
    ProviderParsedOutput,
    VisionProvider,
} from './index.ts';

export const CLAUDE_CLI_DEFAULT_MODEL = 'haiku';

interface ClaudePrintEnvelope {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    session_id?: string;
    duration_ms?: number;
    usage?: unknown;
    [key: string]: unknown;
}

export function buildClaudeCliInvocation(
    options: BuildProviderInvocationOptions,
): ProviderInvocation {
    if (options.imageKind === 'remote') {
        throw new Error(
            'claude-cli provider reads local files only. Download the image first, or use -p gemini-api for remote URLs.',
        );
    }

    const prompt = buildVisionPrompt({
        imageSource: options.imageSource,
        imageKind: 'local',
        extraPrompt: options.extraPrompt,
    });

    const args = [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--json-schema',
        visionResultSchemaJson(),
        '--allowedTools',
        'Read',
        '--model',
        options.model || options.settings?.model || CLAUDE_CLI_DEFAULT_MODEL,
    ];

    return {
        command: options.providerBin || 'claude',
        args,
        cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
    };
}

export function parseClaudeCliOutput(stdout: string): ProviderParsedOutput {
    const envelope = parseEnvelope(stdout);

    if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success')) {
        throw new Error(
            `Claude CLI reported ${envelope.subtype ?? 'an error'}: ${truncate(envelope.result ?? '')}`,
        );
    }

    if (typeof envelope.result !== 'string' || !envelope.result.trim()) {
        throw new Error('Claude CLI output contains no result. Check login state (run: claude).');
    }

    let result: unknown;
    try {
        result = JSON.parse(envelope.result);
    } catch {
        throw new Error(`Claude CLI returned non-JSON result: ${truncate(envelope.result)}`);
    }

    return {
        result,
        meta: {
            conversationId: envelope.session_id ?? null,
            durationSeconds:
                typeof envelope.duration_ms === 'number' ? envelope.duration_ms / 1000 : null,
            usage: envelope.usage ?? null,
        },
    };
}

function parseEnvelope(stdout: string): ClaudePrintEnvelope {
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
        throw new Error('Failed to parse Claude CLI JSON output.');
    }

    return parsed as ClaudePrintEnvelope;
}

function tryParseJson(text: string): unknown | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function truncate(text: string): string {
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

export const claudeCliProvider: VisionProvider = {
    name: 'claude-cli',
    defaultModel: CLAUDE_CLI_DEFAULT_MODEL,
    buildInvocation: buildClaudeCliInvocation,
    parseOutput: parseClaudeCliOutput,
};
