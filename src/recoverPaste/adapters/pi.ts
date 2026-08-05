// Pi stores pasted images the same way Claude Code does, one JSON object per
// line under ~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl, with a slightly
// different image block shape.
import * as os from 'os';
import * as path from 'path';
import { jsonlAdapter } from '../jsonl.ts';
import type { ImageBlockRef } from '../types.ts';

export function piSessionSlug(cwd: string): string {
    const resolved = path.resolve(cwd);
    return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function piExtractLine(line: unknown): ImageBlockRef[] {
    const message = (line as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
        return [];
    }
    const images: ImageBlockRef[] = [];
    for (const block of message.content) {
        const typed = block as { type?: string; data?: string; mimeType?: string };
        if (typed?.type === 'image' && typed.data) {
            images.push({ mediaType: typed.mimeType ?? 'image/png', data: typed.data });
        }
    }
    return images;
}

export const piAdapter = jsonlAdapter({
    name: 'pi',
    dirFor: (cwd) => path.join(os.homedir(), '.pi', 'agent', 'sessions', piSessionSlug(cwd)),
    // pi files look like 2026-08-03T14-18-04-595Z_<uuid>.jsonl
    matchesSession: (fileName, sessionId) => fileName.endsWith(`_${sessionId}.jsonl`),
    extractLine: piExtractLine,
});
