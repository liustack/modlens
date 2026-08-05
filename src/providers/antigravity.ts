import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildVisionPrompt } from '../prompt.ts';
import { visionResultSchemaJson } from '../schema.ts';
import { parseJsonLoose, tryParseJson } from '../util/json.ts';
import type {
    ProviderFailureContext,
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
    const parsed = parseJsonLoose(stdout);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Failed to parse Antigravity CLI JSON output.');
    }
    return parsed as AgyPrintEnvelope;
}

const SWITCH_HINT = `Or switch to a provider with its own quota and no interactive login:
  modlens config set gemini-api.apiKey <key>   # free key, no card: https://aistudio.google.com
  modlens config set provider gemini-api`;

/**
 * agy exits 1 for auth and quota problems alike, and its own envelope says
 * only "Agent execution terminated due to error." The distinguishing evidence
 * lives in agy's log file, so read it before guessing (issue #3).
 */
export function describeAntigravityFailure(context: ProviderFailureContext): string | null {
    // Only lines written after this run started can describe this run. A
    // two-minute window alone let a previous quota failure, or a concurrent
    // agy call, misdiagnose an unrelated error.
    const since = context.startedAt ?? Date.now() - LOG_FRESHNESS_MS;
    let envelope: AgyPrintEnvelope | null = null;
    try {
        envelope = parseEnvelope(context.stdout);
    } catch {
        envelope = null;
    }
    // No agy envelope means agy never ran (missing binary, wrapper, crash), so
    // this is not an agy-level error and its logs say nothing about it.
    if (!envelope) {
        return null;
    }
    const agyError = typeof envelope?.error === 'string' ? envelope.error.trim() : '';
    const evidence = `${agyError}\n${context.stderr}\n${readRecentAgyLog(since)}`.toLowerCase();

    if (evidence.includes('quota')) {
        return [
            agyError || 'Antigravity CLI reported a quota error.',
            "agy's free tier is one weekly bucket shared by the desktop app, the CLI, and the SDK, and subagents drain it in parallel. Wait for the reset shown above, or use a different provider.",
            SWITCH_HINT,
        ].join('\n\n');
    }

    if (
        evidence.includes('not logged into antigravity') ||
        evidence.includes('getting token source') ||
        evidence.includes('keyring') ||
        evidence.includes('failed to read token store')
    ) {
        return [
            'Antigravity CLI cannot read its stored login token.',
            "On Linux this usually means the OS keyring is locked, which is normal for headless sessions (agents, cron, systemd, SSH without a desktop login). agy then reports it as being signed out and tries a browser sign-in that cannot complete without a display. Unlock the keyring, or run modlens from a desktop session, or sign in again with `agy`.",
            SWITCH_HINT,
        ].join('\n\n');
    }

    const totalTokens = (envelope?.usage as { total_tokens?: number } | undefined)?.total_tokens;
    if (agyError || totalTokens === 0) {
        return [
            agyError || 'Antigravity CLI exited before doing any work (no tokens consumed).',
            `Usually auth or quota. Check \`agy\` interactively, and look at the newest log in ${agyLogDir()} for the real reason.`,
            SWITCH_HINT,
        ].join('\n\n');
    }

    return null;
}

function agyLogDir(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
}

// Older logs belong to earlier runs and would misdiagnose this one.
const LOG_FRESHNESS_MS = 2 * 60 * 1000;

/**
 * glog lines look like `I0805 17:50:43.527613 ...`: month, day, wall clock, no
 * year. Returns epoch ms, assuming the current year and the nearest sensible
 * side of a year boundary.
 */
export function parseAgyLogTime(line: string, now = new Date()): number | null {
    const match = /\b[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line);
    if (!match) {
        return null;
    }
    const [, month, day, hour, minute, second, fraction] = match;
    const stamp = new Date(
        now.getFullYear(),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        fraction ? Number(fraction.slice(0, 3)) : 0,
    ).getTime();
    // A log line dated in the future means the year rolled over since it was written.
    return stamp - now.getTime() > 24 * 60 * 60 * 1000
        ? new Date(new Date(stamp).setFullYear(now.getFullYear() - 1)).getTime()
        : stamp;
}

/**
 * Lines from agy's newest log that were written during this run. Filtering by
 * file mtime alone was not enough: a concurrent agy call, or an older failure
 * in the same file, could be read as evidence about this one.
 */
function readRecentAgyLog(since: number): string {
    try {
        const dir = agyLogDir();
        const newest = fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.log'))
            .map((name) => {
                const full = path.join(dir, name);
                return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime)[0];
        // The file must have been touched during this run, not merely recently.
        if (!newest || newest.mtime < since) {
            return '';
        }
        const recent = fs
            .readFileSync(newest.full, 'utf-8')
            .slice(-64_000)
            .split('\n')
            .filter((line) => {
                const stamp = parseAgyLogTime(line);
                return stamp !== null && stamp >= since;
            });
        return recent.join('\n');
    } catch {
        return '';
    }
}

export const antigravityCliProvider: VisionProvider = {
    name: 'antigravity-cli',
    defaultModel: DEFAULT_MODEL,
    buildInvocation: buildAntigravityInvocation,
    parseOutput: parseAntigravityOutput,
    describeFailure: describeAntigravityFailure,
    hasInternalTimeout: true,
};
