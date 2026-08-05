import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    defaultProviderName,
    loadConfigFile,
    resolveProviderSettings,
    type ModlensConfig,
} from './config.ts';
import {
    resolveProvider,
    type ProviderFailureContext,
    type ProviderInvocation,
    type ProviderParsedOutput,
} from './providers/index.ts';

export interface AnalyzeOptions {
    input: string;
    provider?: string;
    model?: string;
    prompt?: string;
    timeoutMs?: number;
    providerBin?: string;
    workdir?: string;
    config?: ModlensConfig;
}

export interface AnalyzeResult {
    image: string;
    provider: string;
    result: unknown;
    meta: {
        generatedAt: string;
        model: string;
        conversationId: string | null;
        durationSeconds: number | null;
        usage: unknown | null;
    };
}

interface CommandResult {
    stdout: string;
    stderr: string;
}

interface ResolvedInput {
    source: string;
    kind: 'local' | 'remote';
}

const DEFAULT_TIMEOUT_MS = 180_000;
// Give the provider's own timeout a chance to fire first; SIGTERM is the backstop.
const KILL_GRACE_MS = 30_000;
// After the provider exits, how long to keep draining stdout before giving up
// on the pipe closing. Reset whenever more output arrives.
const DRAIN_GRACE_MS = 500;

export async function analyzeImage(options: AnalyzeOptions): Promise<AnalyzeResult> {
    const resolvedInput = resolveInput(options.input);
    if (resolvedInput.kind === 'local') {
        validateInputFile(resolvedInput.source);
    }

    const config = options.config ?? loadConfigFile();
    const provider = resolveProvider(options.provider || defaultProviderName(config));
    const settings = resolveProviderSettings(provider.name, config);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const model = options.model || settings.model || provider.defaultModel;

    const providerOptions = {
        imageSource: resolvedInput.source,
        imageKind: resolvedInput.kind,
        model,
        extraPrompt: options.prompt,
        providerBin: options.providerBin,
        workdir: options.workdir,
        timeoutMs,
        settings,
    };

    let parsed: ProviderParsedOutput;
    if (provider.execute) {
        parsed = await provider.execute(providerOptions);
    } else if (provider.buildInvocation && provider.parseOutput) {
        const invocation = provider.buildInvocation(providerOptions);
        const commandResult = await runCommand(
            provider.name,
            invocation,
            timeoutMs + KILL_GRACE_MS,
            provider.describeFailure,
        );
        parsed = provider.parseOutput(commandResult.stdout);
    } else {
        throw new Error(`Provider ${provider.name} implements neither execute nor buildInvocation.`);
    }

    return {
        image: resolvedInput.source,
        provider: provider.name,
        result: parsed.result,
        meta: {
            generatedAt: new Date().toISOString(),
            model,
            conversationId: parsed.meta.conversationId,
            durationSeconds: parsed.meta.durationSeconds,
            usage: parsed.meta.usage,
        },
    };
}

export function resolveInput(input: string): ResolvedInput {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('Input path is required.');
    }

    if (isRemoteSource(trimmed)) {
        return { source: trimmed, kind: 'remote' };
    }

    if (/^file:\/\//i.test(trimmed)) {
        const localPath = decodeURI(trimmed.replace(/^file:\/\//i, ''));
        return { source: path.resolve(localPath), kind: 'local' };
    }

    return { source: path.resolve(trimmed), kind: 'local' };
}

function isRemoteSource(value: string): boolean {
    return /^https?:\/\//i.test(value.trim());
}

function validateInputFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Input image not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Input is not a file: ${filePath}`);
    }
}

/** Exported for tests: the timeout path is otherwise behind a 30s backstop. */
export function runCommand(
    providerName: string,
    invocation: ProviderInvocation,
    timeoutMs: number,
    describeFailure?: (context: ProviderFailureContext) => string | null,
): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let drainTimer: NodeJS.Timeout | undefined;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);

        // 'close' waits for every stdio pipe to close, but agy leaves a
        // language server running that inherited the pipe, so its write end
        // never closes and 'close' never fires (issue #1). Settle on 'exit'
        // plus a drain window instead, and drop the pipes afterwards so the
        // lingering descendant cannot keep this process alive either.
        const settle = (code: number | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearTimeout(drainTimer);
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();

            if (timedOut) {
                reject(new Error(`${providerName} provider timed out after ${timeoutMs} ms.`));
                return;
            }
            if (code !== 0) {
                // The provider knows what its own error output means; a bare
                // exit code tells the user nothing actionable (issue #3).
                const explained = describeFailure?.({ stdout, stderr, code }) ?? null;
                reject(
                    new Error(
                        explained ??
                            `${providerName} provider failed with code ${code}.${stderr ? ` stderr: ${stderr.trim()}` : ''}`,
                    ),
                );
                return;
            }
            resolve({ stdout, stderr });
        };

        let exitCode: number | null = null;
        let exited = false;
        const restartDrain = () => {
            if (!exited || settled) {
                return;
            }
            clearTimeout(drainTimer);
            drainTimer = setTimeout(() => settle(exitCode), DRAIN_GRACE_MS);
        };

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            restartDrain();
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
            restartDrain();
        });

        child.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearTimeout(drainTimer);
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(
                    new Error(
                        `Provider CLI not found: ${invocation.command}. Install Antigravity CLI and sign in first.`,
                    ),
                );
                return;
            }
            reject(error);
        });

        child.on('exit', (code) => {
            exitCode = code;
            exited = true;
            restartDrain();
        });

        // Normal providers close their pipes right after exiting: settle at once.
        child.on('close', (code) => settle(code));
    });
}
