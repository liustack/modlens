import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { mimeTypeFor, readLocalImageBase64 } from './imageInput.ts';

describe('mimeTypeFor', () => {
    it('maps common extensions', () => {
        expect(mimeTypeFor('/a/b/photo.PNG')).toBe('image/png');
        expect(mimeTypeFor('shot.jpeg')).toBe('image/jpeg');
        expect(mimeTypeFor('anim.webp')).toBe('image/webp');
    });

    it('handles urls with query strings and unknown extensions', () => {
        expect(mimeTypeFor('https://x.example.com/pic.png?w=100')).toBe('image/png');
        expect(mimeTypeFor('/tmp/mystery.bin')).toBe('image/jpeg');
    });

    it('keeps the extension of local paths containing # or ?', () => {
        // new URL() would read these as a fragment/query and lose the extension.
        expect(mimeTypeFor('/tmp/shot#2.png')).toBe('image/png');
        expect(mimeTypeFor('/tmp/report?draft.webp')).toBe('image/webp');
    });
});

describe('readLocalImageBase64', () => {
    it('reads bytes and pairs them with the extension mime', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-img-'));
        const file = path.join(dir, 'x.png');
        fs.writeFileSync(file, Buffer.from('bytes'));
        const image = readLocalImageBase64(file);
        expect(image.mimeType).toBe('image/png');
        expect(Buffer.from(image.data, 'base64').toString()).toBe('bytes');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
