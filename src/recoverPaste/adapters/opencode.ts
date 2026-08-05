// OpenCode stores pasted images as data-URL file parts in a SQLite database
// (~/.local/share/opencode/opencode.db), joined to their message (role) and
// session (directory). Reading it needs node:sqlite, which ships with Node 22.5+.
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import type { HarnessAdapter, ImageBlockRef, SourceRef } from '../types.ts';

export function opencodeDbPath(): string {
    return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/** LIKE reads _ and % as wildcards, so a literal path must escape them. */
export function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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
        //
        // Two traps live here. LIKE treats _ and % as wildcards, so a project
        // path containing either matched other projects until escaped. And a
        // session id or slug is not unique across projects, so it narrows the
        // directory match rather than replacing it.
        const directoryFilter = `(session.directory = ? OR session.directory LIKE ? || '/%' ESCAPE '\\' OR ? LIKE session.directory || '/%' ESCAPE '\\')`;
        const escaped = escapeLikePattern(resolved);
        const sessionFilter = sessionId
            ? `AND ${directoryFilter} AND (session.id = ? OR session.slug = ?)`
            : `AND ${directoryFilter}`;
        const params = sessionId
            ? [resolved, escaped, resolved, sessionId, sessionId]
            : [resolved, escaped, resolved];
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

export function opencodeImagesFromRows(rows: SqliteRow[]): ImageBlockRef[] {
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

/** JSONL harnesses locate by transcript path; opencode locates by db query. */
export function opencodeSourceFor(dbPath: string, cwd: string): SourceRef {
    return {
        harness: 'opencode',
        location: dbPath,
        extract: () => opencodeImagesFromRows(opencodeQuery(dbPath, cwd)),
    };
}

export const opencodeAdapter: HarnessAdapter = {
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
