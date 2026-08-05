import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeImage, resolveInput, runCommand } from './analyzer.ts';

describe('resolveInput', () => {
    it('resolves local paths to absolute paths', () => {
        const resolved = resolveInput('some/dir/img.png');
        expect(resolved.kind).toBe('local');
        expect(resolved.source.startsWith('/')).toBe(true);
        expect(resolved.source.endsWith('some/dir/img.png')).toBe(true);
    });

    it('keeps https URLs as remote sources', () => {
        const resolved = resolveInput('https://example.com/demo.png');
        expect(resolved).toEqual({ source: 'https://example.com/demo.png', kind: 'remote' });
    });

    it('unwraps file:// URLs into local paths', () => {
        const resolved = resolveInput('file:///tmp/shot.png');
        expect(resolved).toEqual({ source: '/tmp/shot.png', kind: 'local' });
    });

    it('rejects empty input', () => {
        expect(() => resolveInput('  ')).toThrow('Input path is required.');
    });
});

describe('provider subprocess handling', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) {
            cleanups.pop()?.();
        }
    });

    /** Fake provider binary plus a throwaway image to analyze. */
    function fakeProvider(script: string) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-proc-'));
        const bin = path.join(dir, 'fake-agy');
        fs.writeFileSync(bin, script, { mode: 0o755 });
        const image = path.join(dir, 'image.png');
        fs.writeFileSync(image, 'not-a-real-png');
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        return { bin, image };
    }

    const SUCCESS_ENVELOPE =
        '{"status":"SUCCESS","structured_output":{"summary":"ok","ocr":{"full_text":""}}}';

    it('returns as soon as the provider exits, even when a descendant holds the stdout pipe open', async () => {
        // agy leaves a language server running that inherited the pipe, so the
        // child's 'close' event never fires and the run used to hang until the
        // timeout killed it (issue #1).
        const { bin, image } = fakeProvider(
            `#!/bin/sh\necho '${SUCCESS_ENVELOPE}'\nsleep 30 &\nexit 0\n`,
        );

        const startedAt = Date.now();
        const result = await analyzeImage({
            input: image,
            providerBin: bin,
            timeoutMs: 20_000,
            config: {},
        });

        expect((result.result as { summary: string }).summary).toBe('ok');
        expect(Date.now() - startedAt).toBeLessThan(10_000);
    }, 30_000);

    it('still reports a non-zero exit with its stderr', async () => {
        const { bin, image } = fakeProvider(
            '#!/bin/sh\necho "boom" >&2\nsleep 30 &\nexit 3\n',
        );

        await expect(
            analyzeImage({ input: image, providerBin: bin, timeoutMs: 20_000, config: {} }),
        ).rejects.toThrow(/failed with code 3.*boom/s);
    }, 30_000);

    it('reports a timeout when the provider never exits', async () => {
        // Straight at runCommand: analyzeImage adds a 30s kill backstop on top
        // of the caller's timeout, which would make this test crawl.
        const { bin } = fakeProvider('#!/bin/sh\nsleep 30\n');

        await expect(
            runCommand('fake', { command: bin, args: [], cwd: os.tmpdir() }, 1_000),
        ).rejects.toThrow(/timed out after 1000 ms/);
    }, 20_000);
});
