import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverPastedImages } from '../index.ts';
import { escapeLikePattern } from './opencode.ts';

// The suite itself runs inside a real harness, so default every test to
// unscoped scanning.
beforeEach(() => {
    process.env.MODLENS_HARNESS = 'none';
});
afterEach(() => {
    delete process.env.MODLENS_HARNESS;
});

describe('escapeLikePattern', () => {
    it('escapes SQL wildcards so a path with _ cannot match another project', () => {
        // LIKE reads _ as "any character", so /tmp/proj_1 used to match projA1.
        expect(escapeLikePattern('/tmp/proj_1')).toBe('/tmp/proj\\_1');
        expect(escapeLikePattern('/tmp/100%/x')).toBe('/tmp/100\\%/x');
        expect(escapeLikePattern('/tmp/plain')).toBe('/tmp/plain');
    });
});

// node:sqlite ships (unflagged) only on Node 24+, so these DB-backed tests are
// skipped on older runtimes rather than crashing the suite. The recovery path
// itself degrades gracefully there: opencode surfaces as a "Blocked:" note while
// the JSONL harnesses keep working, which the index suite covers.
let DatabaseSync: (new (p: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...params: unknown[]) => void };
    close: () => void;
}) | undefined;
try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch {
    DatabaseSync = undefined;
}

describe.skipIf(!DatabaseSync)('opencode harness support', () => {
    const Db = DatabaseSync as NonNullable<typeof DatabaseSync>;

    function openDb(home: string) {
        const dir = path.join(home, '.local', 'share', 'opencode');
        fs.mkdirSync(dir, { recursive: true });
        const db = new Db(path.join(dir, 'opencode.db'));
        db.exec(`
            CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, slug TEXT, directory TEXT);
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        `);
        return db;
    }

    function insertImage(
        db: InstanceType<typeof Db>,
        n: number,
        slug: string,
        directory: string,
        timeMs: number,
        payload: string,
    ) {
        db.prepare('INSERT OR IGNORE INTO session VALUES (?, ?, ?)').run(`ses_${n}`, slug, directory);
        db.prepare(`INSERT INTO message VALUES (?, ?, ?, '{"role":"user"}')`).run(
            `msg_${n}`,
            `ses_${n}`,
            timeMs,
        );
        db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
            `prt_${n}`,
            `msg_${n}`,
            `ses_${n}`,
            timeMs,
            JSON.stringify({
                type: 'file',
                mime: 'image/png',
                filename: `f${n}.png`,
                url: `data:image/png;base64,${Buffer.from(payload).toString('base64')}`,
            }),
        );
    }

    function withHome<T>(home: string, run: () => T): T {
        const realHome = process.env.HOME;
        process.env.HOME = home;
        try {
            return run();
        } finally {
            process.env.HOME = realHome;
            fs.rmSync(home, { recursive: true, force: true });
        }
    }

    function imageLine(data: string, timestamp: string, mediaType = 'image/png'): string {
        return JSON.stringify({
            timestamp,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: Buffer.from(data).toString('base64'),
                        },
                    },
                ],
            },
        });
    }

    it('recovers file parts by directory and by session, reporting the original filename', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-oc-'));
        const cwd = '/tmp/proj';
        const db = openDb(home);
        insertImage(db, 1, 'my-session', path.resolve(cwd), Date.parse('2026-08-03T06:00:00.000Z'), 'oc-image');
        db.close();

        withHome(home, () => {
            const result = recoverPastedImages({ cwd, outDir: path.join(home, 'out') });
            expect(result.harness).toBe('opencode');
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('oc-image');
            expect(result.images[0].filename).toBe('f1.png');

            const bySlug = recoverPastedImages({ cwd, session: 'my-session', outDir: path.join(home, 'out') });
            expect(bySlug.harness).toBe('opencode');
        });
    });

    it('matches sessions across the repo-root/subdirectory gap in both directions', () => {
        // opencode records session.directory where it was launched, but runs
        // bash at the repo root; recovery must survive the mismatch.
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-oc-dir-'));
        const root = '/tmp/repo';
        const db = openDb(home);
        insertImage(db, 1, 's-sub', path.join(path.resolve(root), 'assets'), 1_000, 'launched-in-subdir');
        db.close();

        withHome(home, () => {
            const fromRoot = recoverPastedImages({ cwd: root, outDir: path.join(home, 'out') });
            expect(fromRoot.harness).toBe('opencode');
            expect(fs.readFileSync(fromRoot.images[0].path).toString()).toBe('launched-in-subdir');

            const fromDeeper = recoverPastedImages({
                cwd: path.join(root, 'assets', 'icons'),
                outDir: path.join(home, 'out'),
            });
            expect(fs.readFileSync(fromDeeper.images[0].path).toString()).toBe('launched-in-subdir');
        });
    });

    it('scopes recovery to the single session owning the newest image', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-oc-scope-'));
        const cwd = '/tmp/proj';
        const db = openDb(home);
        insertImage(db, 1, 's-old', path.resolve(cwd), 1_000, 'old-session-image');
        insertImage(db, 2, 's-new', path.resolve(cwd), 2_000, 'new-session-image');
        db.close();

        withHome(home, () => {
            const result = recoverPastedImages({ cwd, count: 5, outDir: path.join(home, 'out') });
            expect(result.images).toHaveLength(1);
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('new-session-image');
        });
    });

    it('outranks older jsonl images when its part is newest', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-oc2-'));
        const cwd = '/tmp/proj';
        const claudeDir = path.join(home, '.claude', 'projects', '-tmp-proj');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(
            path.join(claudeDir, 'c.jsonl'),
            imageLine('claude-older', '2026-08-03T01:00:00.000Z'),
        );
        const db = openDb(home);
        insertImage(db, 1, 's1', path.resolve(cwd), Date.parse('2026-08-03T09:00:00.000Z'), 'oc-newer');
        db.close();

        withHome(home, () => {
            const result = recoverPastedImages({ cwd, outDir: path.join(home, 'out') });
            expect(result.harness).toBe('opencode');
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('oc-newer');
        });
    });
});
