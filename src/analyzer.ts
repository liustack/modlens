import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildVisionPrompt } from './prompt.ts';

export interface BuildGeminiInvocationOptions {
    imagePath: string;
    model?: string;
    geminiBin?: string;
    workspaceDir?: string;
    extraPrompt?: string;
}

export interface GeminiInvocation {
    command: string;
    args: string[];
    cwd: string;
}

export interface GeminiCliJsonOutput {
    session_id?: string;
    response: string;
    stats?: unknown;
    [key: string]: unknown;
}

export interface ExtractedStructuredResponse {
    structured: unknown | null;
    rawText: string;
}

export interface AnalyzeOptions {
    input: string;
    model?: string;
    prompt?: string;
    timeoutMs?: number;
    geminiBin?: string;
    workspaceDir?: string;
}

export interface AnalyzeResult {
    image: string;
    structured: unknown | null;
    rawText: string;
    meta: {
        generatedAt: string;
        model: string | null;
        geminiSessionId: string | null;
        geminiStats: unknown | null;
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
const ESCAPE_AT_PATH_REGEX = /([\\\s,;!?()[\]{}])/g;

export function escapeAtPath(filePath: string): string {
    return filePath.replace(ESCAPE_AT_PATH_REGEX, '\\$1');
}

export function buildGeminiInvocation(options: BuildGeminiInvocationOptions): GeminiInvocation {
    const isRemote = isRemoteSource(options.imagePath);
    const imageSource = isRemote ? options.imagePath.trim() : path.resolve(options.imagePath);
    const imageDir = path.dirname(imageSource);
    const prompt = buildVisionPrompt(imageSource, options.extraPrompt);

    const args = ['-p', prompt, '--output-format', 'json'];

    if (options.model) {
        args.push('-m', options.model);
    }

    return {
        command: options.geminiBin || 'gemini',
        args,
        cwd: options.workspaceDir || (isRemote ? process.cwd() : imageDir),
    };
}

export function parseGeminiCliJsonOutput(stdout: string): GeminiCliJsonOutput {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout.trim());
    } catch (error) {
        throw new Error(`Failed to parse Gemini JSON output: ${(error as Error).message}`);
    }

    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { response?: unknown }).response !== 'string') {
        throw new Error('Gemini JSON output is missing a string `response` field.');
    }

    return parsed as GeminiCliJsonOutput;
}

export function extractStructuredResponse(text: string): ExtractedStructuredResponse {
    const rawText = text.trim();

    const direct = tryParseJson(rawText);
    if (direct !== null) {
        return {
            structured: direct,
            rawText,
        };
    }

    const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText);
    if (fencedMatch) {
        const parsedFenced = tryParseJson(fencedMatch[1].trim());
        if (parsedFenced !== null) {
            return {
                structured: parsedFenced,
                rawText,
            };
        }
    }

    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const possibleJson = rawText.slice(firstBrace, lastBrace + 1);
        const parsedObject = tryParseJson(possibleJson);
        if (parsedObject !== null) {
            return {
                structured: parsedObject,
                rawText,
            };
        }
    }

    return {
        structured: null,
        rawText,
    };
}

export async function analyzeImage(options: AnalyzeOptions): Promise<AnalyzeResult> {
    const resolvedInput = resolveInput(options.input);
    if (resolvedInput.kind === 'local') {
        validateInputFile(resolvedInput.source);
    }

    const invocation = buildGeminiInvocation({
        imagePath: resolvedInput.source,
        model: options.model,
        geminiBin: options.geminiBin,
        workspaceDir: options.workspaceDir,
        extraPrompt: options.prompt,
    });

    const commandResult = await runCommand(invocation, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const geminiOutput = parseGeminiCliJsonOutput(commandResult.stdout);
    const extracted = extractStructuredResponse(geminiOutput.response);

    return {
        image: resolvedInput.source,
        structured: extracted.structured,
        rawText: extracted.rawText,
        meta: {
            generatedAt: new Date().toISOString(),
            model: options.model ?? null,
            geminiSessionId: geminiOutput.session_id ?? null,
            geminiStats: geminiOutput.stats ?? null,
        },
    };
}

function resolveInput(input: string): ResolvedInput {
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

function tryParseJson(text: string): unknown | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function runCommand(invocation: GeminiInvocation, timeoutMs: number): Promise<CommandResult> {
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
                reject(new Error(`Gemini CLI not found: ${invocation.command}`));
                return;
            }
            reject(error);
        });

        child.on('close', (code) => {
            clearTimeout(timer);

            if (timedOut) {
                reject(new Error(`Gemini CLI timed out after ${timeoutMs} ms.`));
                return;
            }

            if (code !== 0) {
                reject(
                    new Error(
                        `Gemini CLI failed with code ${code}.${stderr ? ` stderr: ${stderr.trim()}` : ''}`,
                    ),
                );
                return;
            }

            resolve({ stdout, stderr });
        });
    });
}
