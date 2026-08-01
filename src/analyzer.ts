import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveProvider, type ProviderInvocation } from './providers/index.ts';

export interface AnalyzeOptions {
    input: string;
    provider?: string;
    model?: string;
    prompt?: string;
    timeoutMs?: number;
    providerBin?: string;
    workdir?: string;
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

export async function analyzeImage(options: AnalyzeOptions): Promise<AnalyzeResult> {
    const resolvedInput = resolveInput(options.input);
    if (resolvedInput.kind === 'local') {
        validateInputFile(resolvedInput.source);
    }

    const provider = resolveProvider(options.provider);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const model = options.model || provider.defaultModel;

    const invocation = provider.buildInvocation({
        imageSource: resolvedInput.source,
        imageKind: resolvedInput.kind,
        model,
        extraPrompt: options.prompt,
        providerBin: options.providerBin,
        workdir: options.workdir,
        timeoutMs,
    });

    const commandResult = await runCommand(provider.name, invocation, timeoutMs + KILL_GRACE_MS);
    const parsed = provider.parseOutput(commandResult.stdout);

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

function runCommand(
    providerName: string,
    invocation: ProviderInvocation,
    timeoutMs: number,
): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            clearTimeout(timer);
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

        child.on('close', (code) => {
            clearTimeout(timer);

            if (timedOut) {
                reject(new Error(`${providerName} provider timed out after ${timeoutMs} ms.`));
                return;
            }

            if (code !== 0) {
                reject(
                    new Error(
                        `${providerName} provider failed with code ${code}.${stderr ? ` stderr: ${stderr.trim()}` : ''}`,
                    ),
                );
                return;
            }

            resolve({ stdout, stderr });
        });
    });
}
