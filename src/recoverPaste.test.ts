import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    claudeProjectSlug,
    extractUserImages,
    piSessionSlug,
    recoverPastedImages,
} from './recoverPaste.ts';

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

describe('slug encoding', () => {
    it('derives claude project slugs (slashes and dots become dashes)', () => {
        expect(claudeProjectSlug('/Users/leon/projects/liustack-web')).toBe(
            '-Users-leon-projects-liustack-web',
        );
        expect(claudeProjectSlug('/Users/leon/.claude')).toBe('-Users-leon--claude');
    });

    it('derives pi session slugs (leading slash stripped, wrapped in double dashes)', () => {
        expect(piSessionSlug('/tmp/proj')).toBe('--tmp-proj--');
        expect(piSessionSlug('/Users/leon/my-app')).toBe('--Users-leon-my-app--');
    });
});

function piImageLine(data: string, timestamp: string, mimeType = 'image/png'): string {
    return JSON.stringify({
        type: 'message',
        id: 'x',
        parentId: null,
        timestamp,
        message: {
            role: 'user',
            content: [{ type: 'image', data: Buffer.from(data).toString('base64'), mimeType }],
            timestamp: Date.parse(timestamp),
        },
    });
}

describe('extractUserImages + recoverPastedImages', () => {
    it('extracts user image blocks in order, skipping assistant images and junk lines', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-rec-'));
        const transcript = path.join(dir, 's1.jsonl');
        const lines = [
            JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
            imageLine('first-image', '2026-08-03T01:00:00.000Z'),
            'not json at all',
            JSON.stringify({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: Buffer.from('assistant-image').toString('base64'),
                            },
                        },
                    ],
                },
            }),
            imageLine('second-image', '2026-08-03T02:00:00.000Z', 'image/jpeg'),
        ];
        fs.writeFileSync(transcript, lines.join('\n'));

        expect(extractUserImages(transcript)).toHaveLength(2);

        const outDir = path.join(dir, 'out');
        const result = recoverPastedImages({ transcript, count: 1, outDir });
        expect(result.images).toHaveLength(1);
        expect(result.images[0].mediaType).toBe('image/jpeg');
        expect(fs.readFileSync(result.images[0].path).toString()).toBe('second-image');

        const both = recoverPastedImages({ transcript, count: 5, outDir });
        expect(both.images).toHaveLength(2);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fails with guidance when no images exist', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-rec-'));
        const transcript = path.join(dir, 'empty.jsonl');
        fs.writeFileSync(
            transcript,
            JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
        );
        expect(() => recoverPastedImages({ transcript })).toThrow('No pasted images');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('locateTranscript (via recoverPastedImages)', () => {
    it('picks the session with the newest image timestamp, resisting mtime misdirection', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        const cwd = '/tmp/proj';
        const dir = path.join(home, '.claude', 'projects', '-tmp-proj');
        fs.mkdirSync(dir, { recursive: true });

        // session a: older image, but file touched later (concurrent activity)
        fs.writeFileSync(path.join(dir, 'a.jsonl'), imageLine('old-image', '2026-08-03T01:00:00.000Z'));
        // session b: the actual paste, newer image timestamp, older mtime
        fs.writeFileSync(path.join(dir, 'b.jsonl'), imageLine('new-image', '2026-08-03T02:00:00.000Z'));
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(dir, 'b.jsonl'), past, past);

        const realHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const result = recoverPastedImages({ cwd, outDir: path.join(home, 'out') });
            expect(result.transcript.endsWith('b.jsonl')).toBe(true);
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('new-image');
        } finally {
            process.env.HOME = realHome;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('transcriptForSession', () => {
    it('targets the exact session file and errors on a missing one', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-sess-'));
        const cwd = '/tmp/proj';
        const dir = path.join(home, '.claude', 'projects', '-tmp-proj');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'aaaa-bbbb.jsonl'),
            imageLine('exact-image', '2026-08-03T03:00:00.000Z'),
        );
        // decoy with a newer image, to prove --session wins over auto-locate
        fs.writeFileSync(
            path.join(dir, 'cccc-dddd.jsonl'),
            imageLine('decoy-image', '2026-08-03T04:00:00.000Z'),
        );

        const realHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const result = recoverPastedImages({
                cwd,
                session: 'aaaa-bbbb',
                outDir: path.join(home, 'out'),
            });
            expect(result.transcript.endsWith('aaaa-bbbb.jsonl')).toBe(true);
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('exact-image');
            expect(() => recoverPastedImages({ cwd, session: 'missing-id' })).toThrow(
                'No session missing-id with pasted images',
            );
        } finally {
            process.env.HOME = realHome;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('pi harness support', () => {
    it('recovers pi-format images and reports the harness', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-pi-'));
        const cwd = '/tmp/proj';
        const dir = path.join(home, '.pi', 'agent', 'sessions', '--tmp-proj--');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, '2026-08-03T14-18-04-595Z_uuid-1.jsonl'),
            piImageLine('pi-image', '2026-08-03T05:00:00.000Z'),
        );

        const realHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const result = recoverPastedImages({ cwd, outDir: path.join(home, 'out') });
            expect(result.harness).toBe('pi');
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('pi-image');
            const bySession = recoverPastedImages({
                cwd,
                session: 'uuid-1',
                outDir: path.join(home, 'out'),
            });
            expect(bySession.transcript.endsWith('_uuid-1.jsonl')).toBe(true);
        } finally {
            process.env.HOME = realHome;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('picks the globally newest image across claude and pi sessions', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-both-'));
        const cwd = '/tmp/proj';
        const claudeDir = path.join(home, '.claude', 'projects', '-tmp-proj');
        const piDir = path.join(home, '.pi', 'agent', 'sessions', '--tmp-proj--');
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.mkdirSync(piDir, { recursive: true });
        fs.writeFileSync(
            path.join(claudeDir, 'c.jsonl'),
            imageLine('claude-older', '2026-08-03T01:00:00.000Z'),
        );
        fs.writeFileSync(
            path.join(piDir, '2026-08-03T14-00-00-000Z_p.jsonl'),
            piImageLine('pi-newer', '2026-08-03T02:00:00.000Z'),
        );

        const realHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const result = recoverPastedImages({ cwd, outDir: path.join(home, 'out') });
            expect(result.harness).toBe('pi');
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('pi-newer');
        } finally {
            process.env.HOME = realHome;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('opencode harness support', async () => {
    const { recoverPastedImages: recover } = await import('./recoverPaste.ts');
    const { createRequire } = await import('module');
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire('node:sqlite');

    function openDb(home: string) {
        const dir = path.join(home, '.local', 'share', 'opencode');
        fs.mkdirSync(dir, { recursive: true });
        const db = new DatabaseSync(path.join(dir, 'opencode.db'));
        db.exec(`
            CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, slug TEXT, directory TEXT);
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        `);
        return db;
    }

    function insertImage(
        db: InstanceType<typeof DatabaseSync>,
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

    it('recovers file parts by directory and by session, reporting the original filename', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-oc-'));
        const cwd = '/tmp/proj';
        const db = openDb(home);
        insertImage(db, 1, 'my-session', path.resolve(cwd), Date.parse('2026-08-03T06:00:00.000Z'), 'oc-image');
        db.close();

        withHome(home, () => {
            const result = recover({ cwd, outDir: path.join(home, 'out') });
            expect(result.harness).toBe('opencode');
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('oc-image');
            expect(result.images[0].filename).toBe('f1.png');

            const bySlug = recover({ cwd, session: 'my-session', outDir: path.join(home, 'out') });
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
            const fromRoot = recover({ cwd: root, outDir: path.join(home, 'out') });
            expect(fromRoot.harness).toBe('opencode');
            expect(fs.readFileSync(fromRoot.images[0].path).toString()).toBe('launched-in-subdir');

            const fromDeeper = recover({
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
            const result = recover({ cwd, count: 5, outDir: path.join(home, 'out') });
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
            const result = recover({ cwd, outDir: path.join(home, 'out') });
            expect(result.harness).toBe('opencode');
            expect(fs.readFileSync(result.images[0].path).toString()).toBe('oc-newer');
        });
    });
});
