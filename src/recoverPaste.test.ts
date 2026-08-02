import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { extractUserImages, projectSlug, recoverPastedImages } from './recoverPaste.ts';

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

describe('projectSlug', () => {
    it('derives claude project slugs from cwd (slashes and dots become dashes)', () => {
        expect(projectSlug('/Users/leon/projects/liustack-web')).toBe(
            '-Users-leon-projects-liustack-web',
        );
        expect(projectSlug('/Users/leon/.claude')).toBe('-Users-leon--claude');
    });
});

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
