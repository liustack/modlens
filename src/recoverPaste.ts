// Recover pasted images from agent session storage.
//
// None of the supported harnesses writes pasted images to a regular temp
// file, but all of them persist user messages, image bytes included, locally
// before any gateway-side stripping happens:
//
//   claude    ~/.claude/projects/<slug>/<session>.jsonl
//             line: { timestamp: ISO, message: { role, content: [{ type: "image",
//                     source: { type: "base64", media_type, data } }] } }
//   pi        ~/.pi/agent/sessions/--<encoded-cwd>--/<stamp>_<session>.jsonl
//             line: { type: "message", timestamp: ISO, message: { role,
//                     content: [{ type: "image", data, mimeType }] } }
//   opencode  ~/.local/share/opencode/opencode.db (SQLite, needs node:sqlite,
//             Node 22.5+): part.data = { type: "file", mime, url: dataURL },
//             joined to message (role) and session (directory)
//
// Storage layouts are internal implementation details of those tools, so this
// can break without notice; callers should fall back to asking for a path.
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RecoveredImage {
    path: string;
    mediaType: string;
    bytes: number;
    /** Original attachment name, when the harness stored one (opencode does). */
    filename?: string;
}

export interface RecoverResult {
    harness: string;
    transcript: string;
    images: RecoveredImage[];
    /** The harness this process was detected to run inside, when detection fired. */
    detected?: string;
}

export interface RecoverOptions {
    cwd?: string;
    transcript?: string;
    session?: string;
    count?: number;
    outDir?: string;
    /** Force the harness scope, bypassing detection ('none' disables scoping). */
    harness?: string;
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
    filename?: string;
}

/** A located source of pasted images: a JSONL transcript or a SQLite db. */
interface SourceRef {
    harness: string;
    /** Displayable location (file path). */
    location: string;
    /** Extract all user images, oldest to newest. */
    extract: () => ImageBlockRef[];
}

interface HarnessAdapter {
    name: string;
    /** Best candidate for this cwd with the newest image timestamp (epoch ms). */
    findNewest(cwd: string): { ref: SourceRef; timestamp: number } | null;
    /** Exact session lookup. */
    findSession(cwd: string, sessionId: string): SourceRef | null;
    /** Where this adapter looks, for error messages. */
    describe(cwd: string): string;
}

// ---------- shared JSONL helpers ----------

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

function jsonlSource(
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
    filePath: string,
    extractLine: (line: unknown) => ImageBlockRef[],
): number | null {
    let latest: number | null = null;
    forEachJsonLine(filePath, (line) => {
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

function jsonlAdapter(options: {
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
                const timestamp = newestJsonlTimestamp(file, extractLine);
                if (timestamp !== null && (!best || timestamp > best.timestamp)) {
                    best = { ref: jsonlSource(name, file, extractLine), timestamp };
                }
            }
            return best;
        },
        findSession: (cwd, sessionId) => {
            for (const file of listJsonl(dirFor(cwd))) {
                if (matchesSession(path.basename(file), sessionId)) {
                    return jsonlSource(name, file, extractLine);
                }
            }
            return null;
        },
    };
}

// ---------- claude code ----------

export function claudeProjectSlug(cwd: string): string {
    return path.resolve(cwd).replace(/[/.]/g, '-');
}

function claudeExtractLine(line: unknown): ImageBlockRef[] {
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

const claudeAdapter = jsonlAdapter({
    name: 'claude-code',
    dirFor: (cwd) => path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd)),
    matchesSession: (fileName, sessionId) => fileName === `${sessionId}.jsonl`,
    extractLine: claudeExtractLine,
});

// ---------- pi ----------

export function piSessionSlug(cwd: string): string {
    const resolved = path.resolve(cwd);
    return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function piExtractLine(line: unknown): ImageBlockRef[] {
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

const piAdapter = jsonlAdapter({
    name: 'pi',
    dirFor: (cwd) => path.join(os.homedir(), '.pi', 'agent', 'sessions', piSessionSlug(cwd)),
    // pi files look like 2026-08-03T14-18-04-595Z_<uuid>.jsonl
    matchesSession: (fileName, sessionId) => fileName.endsWith(`_${sessionId}.jsonl`),
    extractLine: piExtractLine,
});

// ---------- opencode ----------

export function opencodeDbPath(): string {
    return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

interface SqliteRow {
    data: string;
    time_created: number;
    session_id: string;
}

function opencodeQuery(dbPath: string, cwd: string, sessionId?: string): SqliteRow[] {
    // node:sqlite ships with Node 22.5+. Loaded lazily so the other adapters
    // keep working on older runtimes.
    let DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
        prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
        close: () => void;
    };
    try {
        const nodeRequire = createRequire(import.meta.url);
        ({ DatabaseSync } = nodeRequire('node:sqlite'));
    } catch {
        throw new Error(
            'Reading opencode storage needs the node:sqlite module (Node 22.5+). Upgrade Node, or pass --transcript/--session for a JSONL-based harness.',
        );
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const resolved = path.resolve(cwd);
        // opencode's bash tool runs at the repo root while session.directory
        // records where the session was launched (possibly a subdirectory), so
        // directories must match by prefix in both directions, not exactly.
        const sessionFilter = sessionId
            ? `AND (session.id = ? OR session.slug = ?)`
            : `AND (session.directory = ? OR session.directory LIKE ? || '/%' OR ? LIKE session.directory || '/%')`;
        const params = sessionId ? [sessionId, sessionId] : [resolved, resolved, resolved];
        const rows = db
            .prepare(
                `SELECT part.data AS data, part.time_created AS time_created, part.session_id AS session_id
                 FROM part
                 JOIN message ON message.id = part.message_id
                 JOIN session ON session.id = part.session_id
                 WHERE part.data LIKE '{"type":"file"%'
                   AND json_extract(message.data, '$.role') = 'user'
                   ${sessionFilter}
                 ORDER BY part.time_created ASC`,
            )
            .all(...params) as SqliteRow[];
        return rows;
    } finally {
        db.close();
    }
}

function opencodeImagesFromRows(rows: SqliteRow[]): ImageBlockRef[] {
    const images: ImageBlockRef[] = [];
    for (const row of rows) {
        try {
            const part = JSON.parse(row.data) as {
                type?: string;
                mime?: string;
                url?: string;
                filename?: string;
            };
            if (part.type !== 'file' || !part.mime?.startsWith('image/')) {
                continue;
            }
            const match = /^data:[^;]+;base64,(.+)$/.exec(part.url ?? '');
            if (match) {
                images.push({ mediaType: part.mime, data: match[1], filename: part.filename });
            }
        } catch {
            // skip malformed parts
        }
    }
    return images;
}

const opencodeAdapter: HarnessAdapter = {
    name: 'opencode',
    describe: () => opencodeDbPath(),
    findNewest: (cwd) => {
        const dbPath = opencodeDbPath();
        if (!fs.existsSync(dbPath)) {
            return null;
        }
        // One source = one session, like the JSONL adapters: scope to the
        // session owning the newest image part, so other sessions in the same
        // project cannot smuggle extra images into the result.
        const withImages = opencodeQuery(dbPath, cwd)
            .map((row) => ({ row, images: opencodeImagesFromRows([row]) }))
            .filter((entry) => entry.images.length > 0);
        if (withImages.length === 0) {
            return null;
        }
        const newest = withImages[withImages.length - 1];
        const scoped = withImages.filter((entry) => entry.row.session_id === newest.row.session_id);
        return {
            ref: {
                harness: 'opencode',
                location: dbPath,
                extract: () => scoped.flatMap((entry) => entry.images),
            },
            timestamp: newest.row.time_created,
        };
    },
    findSession: (cwd, sessionId) => {
        const dbPath = opencodeDbPath();
        if (!fs.existsSync(dbPath)) {
            return null;
        }
        const rows = opencodeQuery(dbPath, cwd, sessionId);
        if (opencodeImagesFromRows(rows).length === 0) {
            return null;
        }
        return {
            harness: 'opencode',
            location: dbPath,
            extract: () => opencodeImagesFromRows(opencodeQuery(dbPath, cwd, sessionId)),
        };
    },
};

// ---------- harness detection ----------
//
// Recovery must read the storage of the harness this command is actually
// running inside; racing every store by timestamp lets one tool's stale
// sessions hijack another tool's paste. The primary signal is the process
// ancestry: the nearest known harness among our parent processes is the one
// that spawned this command, which also resolves nested setups (opencode
// launched from inside Claude Code) to the innermost harness, the one whose
// input box received the paste. Env fingerprints are the fallback: Claude Code
// injects CLAUDECODE/CLAUDE_CODE_SESSION_ID, pi sets PI_CODING_AGENT, codex
// injects CODEX_THREAD_ID; opencode injects nothing, which is exactly why
// ancestry comes first.

const HARNESS_BY_BASENAME: Record<string, string> = {
    claude: 'claude-code',
    'claude-code': 'claude-code',
    pi: 'pi',
    opencode: 'opencode',
    codex: 'codex',
};

/** Walk the ppid chain in a `ps -Ao pid=,ppid=,command=` table, nearest first. */
export function harnessFromPsTable(psOutput: string, startPid: number): string | null {
    const table = new Map<number, { ppid: number; command: string }>();
    for (const line of psOutput.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match) {
            table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
        }
    }
    let pid: number | undefined = table.get(startPid)?.ppid;
    for (let hops = 0; hops < 50 && pid !== undefined && pid > 1; hops++) {
        const proc = table.get(pid);
        if (!proc) {
            return null;
        }
        // Only the first few tokens (executable, node shim flags, script path):
        // deeper tokens are free-text arguments and would false-positive.
        for (const token of proc.command.trim().split(/\s+/).slice(0, 8)) {
            const mapped = HARNESS_BY_BASENAME[path.basename(token)];
            if (mapped) {
                return mapped;
            }
        }
        pid = proc.ppid;
    }
    return null;
}

function detectHarness(): string | null {
    const override = process.env.MODLENS_HARNESS;
    if (override) {
        return override === 'none' ? null : override;
    }
    try {
        const ps = childProcess.execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], {
            encoding: 'utf-8',
            maxBuffer: 16 * 1024 * 1024,
        });
        const found = harnessFromPsTable(ps, process.pid);
        if (found) {
            return found;
        }
    } catch {
        // ps unavailable (e.g. Windows): fall through to env fingerprints
    }
    if (process.env.PI_CODING_AGENT) {
        return 'pi';
    }
    if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) {
        return 'codex';
    }
    if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) {
        return 'claude-code';
    }
    return null;
}

// ---------- orchestration ----------

const ADAPTERS: HarnessAdapter[] = [claudeAdapter, piAdapter, opencodeAdapter];

function sourceForExplicitPath(filePath: string): SourceRef {
    if (filePath.endsWith('.db')) {
        return {
            harness: 'opencode',
            location: filePath,
            extract: () => opencodeImagesFromRows(opencodeQuery(filePath, process.cwd())),
        };
    }
    if (filePath.includes(`${path.sep}.pi${path.sep}`)) {
        return jsonlSource('pi', filePath, piExtractLine);
    }
    return jsonlSource('claude-code', filePath, claudeExtractLine);
}

export function locateSource(cwd: string, adapters: HarnessAdapter[] = ADAPTERS): SourceRef {
    let best: { ref: SourceRef; timestamp: number } | null = null;
    for (const adapter of adapters) {
        let candidate: { ref: SourceRef; timestamp: number } | null = null;
        try {
            candidate = adapter.findNewest(cwd);
        } catch {
            // an unreadable store should not block the other harnesses
        }
        if (candidate && (!best || candidate.timestamp > best.timestamp)) {
            best = candidate;
        }
    }
    if (!best) {
        const dirs = adapters.map((a) => a.describe(cwd)).join(' , ');
        throw new Error(
            `No pasted images found in any session storage for this directory (looked in: ${dirs}). The user may not have pasted any, or the storage format changed; ask for a file path instead.`,
        );
    }
    return best.ref;
}

export function sourceForSession(
    cwd: string,
    sessionId: string,
    adapters: HarnessAdapter[] = ADAPTERS,
): SourceRef {
    for (const adapter of adapters) {
        try {
            const ref = adapter.findSession(cwd, sessionId);
            if (ref) {
                return ref;
            }
        } catch {
            // keep looking in the other harnesses
        }
    }
    const dirs = adapters.map((a) => a.describe(cwd)).join(' , ');
    throw new Error(
        `No session ${sessionId} with pasted images under this project (looked in: ${dirs}). Check --cwd, or drop --session to auto-locate by newest pasted image.`,
    );
}

export function recoverPastedImages(options: RecoverOptions = {}): RecoverResult {
    const cwd = options.cwd ?? process.cwd();

    const detected = options.transcript ? null : (options.harness ?? detectHarness());
    if (detected === 'codex') {
        throw new Error(
            'This is a Codex session: pasted images already exist as temp files, and each image tag in the message carries its path. Read the path from the tag instead of running recover-paste.',
        );
    }
    const scoped: string | null = detected && detected !== 'none' ? detected : null;
    if (scoped && !ADAPTERS.some((adapter) => adapter.name === scoped)) {
        throw new Error(
            `Unknown harness "${scoped}". Supported: claude-code, pi, opencode (or none to scan all).`,
        );
    }
    const adapters = scoped ? ADAPTERS.filter((adapter) => adapter.name === scoped) : ADAPTERS;

    // Claude Code injects the session id into tool environments, which lets us
    // target the exact transcript without the skill relaying anything. It can
    // point at an imageless transcript (e.g. a subagent session), so fall back
    // to scanning instead of failing when it does not pan out.
    let source: SourceRef | null = null;
    if (options.transcript) {
        source = sourceForExplicitPath(options.transcript);
    } else if (options.session) {
        source = sourceForSession(cwd, options.session, adapters);
    } else {
        const envSession =
            detected === 'claude-code' ? process.env.CLAUDE_CODE_SESSION_ID : undefined;
        if (envSession) {
            try {
                source = sourceForSession(cwd, envSession, adapters);
            } catch {
                source = null;
            }
        }
        source ??= locateSource(cwd, adapters);
    }
    const count = Math.max(1, options.count ?? 1);
    const outDir = options.outDir ?? path.join(os.tmpdir(), 'modlens-paste');

    const all = source.extract();
    if (all.length === 0) {
        throw new Error(
            `No pasted images found in ${source.location}. The user may not have pasted any, or the storage format changed; ask for a file path instead.`,
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
        const recovered: RecoveredImage = {
            path: filePath,
            mediaType: image.mediaType,
            bytes: buffer.length,
        };
        if (image.filename) {
            recovered.filename = image.filename;
        }
        return recovered;
    });

    const result: RecoverResult = { harness: source.harness, transcript: source.location, images };
    if (scoped) {
        result.detected = scoped;
    }
    return result;
}

// Back-compat named export used by tests for JSONL extraction.
export function extractUserImages(transcriptPath: string): ImageBlockRef[] {
    return sourceForExplicitPath(transcriptPath).extract();
}
