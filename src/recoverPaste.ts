// Recover pasted images from Claude Code session transcripts.
//
// Claude Code never writes pasted images to a regular temp file, but it does
// append every user message, image blocks included, to the session transcript
// at ~/.claude/projects/<cwd-slug>/<session>.jsonl. Gateway-side stripping
// happens after that write, so the original bytes are always recoverable
// locally. Transcript layout is an internal implementation detail of Claude
// Code, so this can break without notice; callers should fall back to asking
// for a file path.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RecoveredImage {
    path: string;
    mediaType: string;
    bytes: number;
}

export interface RecoverResult {
    transcript: string;
    images: RecoveredImage[];
}

export interface RecoverOptions {
    cwd?: string;
    transcript?: string;
    session?: string;
    count?: number;
    outDir?: string;
}

const EXT_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

export function projectSlug(cwd: string): string {
    return path.resolve(cwd).replace(/[/.]/g, '-');
}

// Transcripts are per-session files (the filename is the session id). A Bash
// child has no env clue about which session invoked it, so instead of guessing
// by file mtime we pick the transcript holding the globally newest user image
// message. The session the user just pasted into necessarily owns it, which
// keeps concurrent sessions in the same project from stealing the match.
export function locateTranscript(cwd: string): string {
    const dir = path.join(os.homedir(), '.claude', 'projects', projectSlug(cwd));
    let entries: string[];
    try {
        entries = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
        throw new Error(
            `No Claude Code transcripts found for this directory (${dir}). Run from the project the image was pasted in, or pass --transcript <path>.`,
        );
    }
    if (entries.length === 0) {
        throw new Error(`No transcripts in ${dir}. Pass --transcript <path> to pick one manually.`);
    }

    let best: { full: string; timestamp: string } | null = null;
    for (const name of entries) {
        const full = path.join(dir, name);
        const timestamp = lastImageTimestamp(full);
        if (timestamp && (!best || timestamp > best.timestamp)) {
            best = { full, timestamp };
        }
    }
    if (!best) {
        throw new Error(
            `No pasted images found in any transcript under ${dir}. The user may not have pasted any, or the transcript format changed; ask for a file path instead.`,
        );
    }
    return best.full;
}

function lastImageTimestamp(transcriptPath: string): string | null {
    let raw: string;
    try {
        raw = fs.readFileSync(transcriptPath, 'utf-8');
    } catch {
        return null;
    }
    let latest: string | null = null;
    for (const line of raw.split('\n')) {
        if (!line.includes('"image"')) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        const entry = parsed as {
            timestamp?: string;
            message?: { role?: string; content?: unknown };
        };
        if (entry.message?.role !== 'user' || !Array.isArray(entry.message.content)) {
            continue;
        }
        const hasImage = entry.message.content.some(
            (block) =>
                (block as { type?: string; source?: { type?: string } })?.type === 'image' &&
                (block as { source?: { type?: string } }).source?.type === 'base64',
        );
        if (hasImage && entry.timestamp && (!latest || entry.timestamp > latest)) {
            latest = entry.timestamp;
        }
    }
    return latest;
}

interface ImageBlockRef {
    mediaType: string;
    data: string;
}

export function extractUserImages(transcriptPath: string): ImageBlockRef[] {
    let raw: string;
    try {
        raw = fs.readFileSync(transcriptPath, 'utf-8');
    } catch (error) {
        throw new Error(`Cannot read transcript ${transcriptPath}: ${(error as Error).message}`);
    }

    const images: ImageBlockRef[] = [];
    for (const line of raw.split('\n')) {
        if (!line.includes('"image"')) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        const message = (parsed as { message?: { role?: string; content?: unknown } }).message;
        if (message?.role !== 'user' || !Array.isArray(message.content)) {
            continue;
        }
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
    }
    return images;
}

export function transcriptForSession(cwd: string, sessionId: string): string {
    const file = path.join(
        os.homedir(),
        '.claude',
        'projects',
        projectSlug(cwd),
        `${sessionId}.jsonl`,
    );
    if (!fs.existsSync(file)) {
        throw new Error(
            `No transcript for session ${sessionId} under this project (${file}). Check --cwd, or drop --session to auto-locate by newest pasted image.`,
        );
    }
    return file;
}

export function recoverPastedImages(options: RecoverOptions = {}): RecoverResult {
    const cwd = options.cwd ?? process.cwd();
    const transcript =
        options.transcript ??
        (options.session ? transcriptForSession(cwd, options.session) : locateTranscript(cwd));
    const count = Math.max(1, options.count ?? 1);
    const outDir = options.outDir ?? path.join(os.tmpdir(), 'modlens-paste');

    const all = extractUserImages(transcript);
    if (all.length === 0) {
        throw new Error(
            `No pasted images found in ${transcript}. The user may not have pasted any, or the transcript format changed; ask for a file path instead.`,
        );
    }

    fs.mkdirSync(outDir, { recursive: true });
    const picked = all.slice(-count);
    const images: RecoveredImage[] = picked.map((image) => {
        const buffer = Buffer.from(image.data, 'base64');
        const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);
        const ext = EXT_BY_MIME[image.mediaType] ?? 'png';
        const filePath = path.join(outDir, `paste-${hash}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        return { path: filePath, mediaType: image.mediaType, bytes: buffer.length };
    });

    return { transcript, images };
}
