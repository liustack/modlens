// Recover pasted images from agent session transcripts.
//
// Neither Claude Code nor Pi writes pasted images to a regular temp file, but
// both append every user message, image blocks included, to a local session
// file before any gateway-side stripping happens:
//
//   claude  ~/.claude/projects/<slug>/<session>.jsonl
//           line: { timestamp: ISO, message: { role, content: [{ type: "image",
//                   source: { type: "base64", media_type, data } }] } }
//   pi      ~/.pi/agent/sessions/--<encoded-cwd>--/<stamp>_<session>.jsonl
//           line: { type: "message", timestamp: ISO, message: { role,
//                   content: [{ type: "image", data, mimeType }] } }
//
// Transcript layouts are internal implementation details of those tools, so
// this can break without notice; callers should fall back to asking for a
// file path.
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
    harness: string;
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

interface ImageBlockRef {
    mediaType: string;
    data: string;
}

interface HarnessAdapter {
    name: string;
    sessionDir(cwd: string): string;
    matchesSession(fileName: string, sessionId: string): boolean;
    extractUserImages(line: unknown): ImageBlockRef[];
}

export function claudeProjectSlug(cwd: string): string {
    return path.resolve(cwd).replace(/[/.]/g, '-');
}

export function piSessionSlug(cwd: string): string {
    const resolved = path.resolve(cwd);
    return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

const claudeAdapter: HarnessAdapter = {
    name: 'claude-code',
    sessionDir: (cwd) => path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd)),
    matchesSession: (fileName, sessionId) => fileName === `${sessionId}.jsonl`,
    extractUserImages: (line) => {
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
    },
};

const piAdapter: HarnessAdapter = {
    name: 'pi',
    sessionDir: (cwd) => path.join(os.homedir(), '.pi', 'agent', 'sessions', piSessionSlug(cwd)),
    // pi files look like 2026-08-03T14-18-04-595Z_<uuid>.jsonl
    matchesSession: (fileName, sessionId) => fileName.endsWith(`_${sessionId}.jsonl`),
    extractUserImages: (line) => {
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
    },
};

const ADAPTERS = [claudeAdapter, piAdapter];

interface TranscriptCandidate {
    harness: string;
    transcript: string;
    timestamp: string;
}

function lineTimestamp(line: unknown): string | null {
    const ts = (line as { timestamp?: unknown }).timestamp;
    return typeof ts === 'string' ? ts : null;
}

function forEachJsonLine(filePath: string, visit: (line: unknown) => void): void {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return;
    }
    for (const line of raw.split('\n')) {
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

function newestImageTimestamp(adapter: HarnessAdapter, filePath: string): string | null {
    let latest: string | null = null;
    forEachJsonLine(filePath, (line) => {
        if (adapter.extractUserImages(line).length === 0) {
            return;
        }
        const ts = lineTimestamp(line);
        if (ts && (!latest || ts > latest)) {
            latest = ts;
        }
    });
    return latest;
}

function listTranscripts(adapter: HarnessAdapter, cwd: string): string[] {
    try {
        return fs
            .readdirSync(adapter.sessionDir(cwd))
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => path.join(adapter.sessionDir(cwd), name));
    } catch {
        return [];
    }
}

/** Pick the transcript holding the globally newest pasted image across all
 * known harnesses: the session the user just pasted into necessarily owns it,
 * which keeps concurrent sessions from stealing the match. */
export function locateTranscript(cwd: string): { harness: string; transcript: string } {
    const candidates: TranscriptCandidate[] = [];
    for (const adapter of ADAPTERS) {
        for (const transcript of listTranscripts(adapter, cwd)) {
            const timestamp = newestImageTimestamp(adapter, transcript);
            if (timestamp) {
                candidates.push({ harness: adapter.name, transcript, timestamp });
            }
        }
    }
    if (candidates.length === 0) {
        const dirs = ADAPTERS.map((a) => a.sessionDir(cwd)).join(' , ');
        throw new Error(
            `No pasted images found in any session transcript for this directory (looked in: ${dirs}). The user may not have pasted any, or the transcript format changed; ask for a file path instead.`,
        );
    }
    candidates.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return { harness: candidates[0].harness, transcript: candidates[0].transcript };
}

export function transcriptForSession(
    cwd: string,
    sessionId: string,
): { harness: string; transcript: string } {
    for (const adapter of ADAPTERS) {
        for (const transcript of listTranscripts(adapter, cwd)) {
            if (adapter.matchesSession(path.basename(transcript), sessionId)) {
                return { harness: adapter.name, transcript };
            }
        }
    }
    const dirs = ADAPTERS.map((a) => a.sessionDir(cwd)).join(' , ');
    throw new Error(
        `No transcript for session ${sessionId} under this project (looked in: ${dirs}). Check --cwd, or drop --session to auto-locate by newest pasted image.`,
    );
}

function adapterFor(transcript: string): HarnessAdapter {
    if (transcript.includes(`${path.sep}.pi${path.sep}`)) {
        return piAdapter;
    }
    return claudeAdapter;
}

export function extractUserImages(transcriptPath: string): ImageBlockRef[] {
    const adapter = adapterFor(transcriptPath);
    const images: ImageBlockRef[] = [];
    forEachJsonLine(transcriptPath, (line) => {
        images.push(...adapter.extractUserImages(line));
    });
    return images;
}

export function recoverPastedImages(options: RecoverOptions = {}): RecoverResult {
    const cwd = options.cwd ?? process.cwd();
    const located = options.transcript
        ? { harness: adapterFor(options.transcript).name, transcript: options.transcript }
        : options.session
          ? transcriptForSession(cwd, options.session)
          : locateTranscript(cwd);
    const count = Math.max(1, options.count ?? 1);
    const outDir = options.outDir ?? path.join(os.tmpdir(), 'modlens-paste');

    const all = extractUserImages(located.transcript);
    if (all.length === 0) {
        throw new Error(
            `No pasted images found in ${located.transcript}. The user may not have pasted any, or the transcript format changed; ask for a file path instead.`,
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

    return { harness: located.harness, transcript: located.transcript, images };
}
