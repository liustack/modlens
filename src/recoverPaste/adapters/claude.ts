// Claude Code stores pasted images as base64 blocks inside
// ~/.claude/projects/<slug>/<session>.jsonl.
import * as os from 'os';
import * as path from 'path';
import { jsonlAdapter } from '../jsonl.ts';
import type { ImageBlockRef } from '../types.ts';

export function claudeProjectSlug(cwd: string): string {
    return path.resolve(cwd).replace(/[/.]/g, '-');
}

export function claudeExtractLine(line: unknown): ImageBlockRef[] {
    const message = (line as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
        return [];
    }
    const images: ImageBlockRef[] = [];
    for (const block of message.content) {
        const source = (block as { type?: string; source?: Record<string, string> })?.source;
        if (
            (block as { type?: string })?.type === 'image' &&
            source?.type === 'base64' &&
            source.data
        ) {
            images.push({ mediaType: source.media_type ?? 'image/png', data: source.data });
        }
    }
    return images;
}

export const claudeAdapter = jsonlAdapter({
    name: 'claude-code',
    dirFor: (cwd) => path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd)),
    matchesSession: (fileName, sessionId) => fileName === `${sessionId}.jsonl`,
    extractLine: claudeExtractLine,
});
