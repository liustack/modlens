// Shared helpers for the JSONL-backed harnesses (Claude Code, Pi). Both store
// user messages one JSON object per line, with image bytes inline, so the
// scanning, cwd-verification, and adapter scaffolding are identical between them.
import * as fs from 'fs';
import * as path from 'path';
import type { HarnessAdapter, ImageBlockRef, SourceRef } from './types.ts';

/**
 * Slugs are lossy: /tmp/project.alpha and /tmp/project-alpha collapse to the
 * same Claude slug, and Pi has the same problem with separators. Both harnesses
 * record the real cwd inside the transcript, so check it before trusting a
 * directory match.
 */
export function transcriptBelongsTo(lines: string[], cwd: string): boolean {
    const wanted = path.resolve(cwd);
    let sawCwd = false;

    for (const line of lines) {
        if (!line.includes('"cwd"')) {
            continue;
        }
        try {
            const recorded = (JSON.parse(line) as { cwd?: unknown }).cwd;
            if (typeof recorded !== 'string') {
                continue;
            }
            sawCwd = true;
            const resolved = path.resolve(recorded);
            // Any matching line is enough: a session can start in a
            // subdirectory and one early line must not settle the question,
            // which is what returning on the first cwd used to do.
            if (resolved === wanted || resolved.startsWith(`${wanted}${path.sep}`)) {
                return true;
            }
        } catch {
            // keep looking
        }
    }

    // No cwd recorded at all: the slug is the only evidence we have.
    return !sawCwd;
}

/** Read a transcript once: callers need both its cwd lines and its images. */
export function readLines(filePath: string): string[] | null {
    try {
        return fs.readFileSync(filePath, 'utf-8').split('\n');
    } catch {
        return null;
    }
}

function forEachJsonLine(filePath: string, visit: (line: unknown) => void): void {
    const lines = readLines(filePath);
    if (!lines) {
        return;
    }
    forEachParsedLine(lines, visit);
}

function forEachParsedLine(lines: string[], visit: (line: unknown) => void): void {
    for (const line of lines) {
        if (!line.includes('"image"')) {
            continue;
        }
        try {
            visit(JSON.parse(line));
        } catch {
            // skip malformed lines
        }
    }
}

export function jsonlSource(
    harness: string,
    filePath: string,
    extractLine: (line: unknown) => ImageBlockRef[],
): SourceRef {
    return {
        harness,
        location: filePath,
        extract: () => {
            const images: ImageBlockRef[] = [];
            forEachJsonLine(filePath, (line) => {
                images.push(...extractLine(line));
            });
            return images;
        },
    };
}

function newestJsonlTimestamp(
    lines: string[],
    extractLine: (line: unknown) => ImageBlockRef[],
): number | null {
    let latest: number | null = null;
    forEachParsedLine(lines, (line) => {
        if (extractLine(line).length === 0) {
            return;
        }
        const ts = (line as { timestamp?: unknown }).timestamp;
        const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
        if (Number.isFinite(ms) && (latest === null || ms > latest)) {
            latest = ms;
        }
    });
    return latest;
}

function listJsonl(dir: string): string[] {
    try {
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => path.join(dir, name));
    } catch {
        return [];
    }
}

export function jsonlAdapter(options: {
    name: string;
    dirFor: (cwd: string) => string;
    matchesSession: (fileName: string, sessionId: string) => boolean;
    extractLine: (line: unknown) => ImageBlockRef[];
}): HarnessAdapter {
    const { name, dirFor, matchesSession, extractLine } = options;
    return {
        name,
        describe: (cwd) => dirFor(cwd),
        findNewest: (cwd) => {
            let best: { ref: SourceRef; timestamp: number } | null = null;
            for (const file of listJsonl(dirFor(cwd))) {
                const lines = readLines(file);
                if (!lines || !transcriptBelongsTo(lines, cwd)) {
                    continue;
                }
                const timestamp = newestJsonlTimestamp(lines, extractLine);
                if (timestamp !== null && (!best || timestamp > best.timestamp)) {
                    best = { ref: jsonlSource(name, file, extractLine), timestamp };
                }
            }
            return best;
        },
        findSession: (cwd, sessionId) => {
            for (const file of listJsonl(dirFor(cwd))) {
                if (!matchesSession(path.basename(file), sessionId)) {
                    continue;
                }
                const lines = readLines(file);
                if (lines && transcriptBelongsTo(lines, cwd)) {
                    return jsonlSource(name, file, extractLine);
                }
            }
            return null;
        },
    };
}
