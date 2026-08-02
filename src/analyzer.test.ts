import { describe, expect, it } from 'vitest';
import { resolveInput } from './analyzer.ts';

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
