import { describe, expect, it } from 'vitest';
import { extractJson, parseJsonLoose, truncate, tryParseJson } from './json.ts';

describe('tryParseJson', () => {
    it('parses valid json and returns null for invalid', () => {
        expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
        expect(tryParseJson('nope')).toBeNull();
    });
});

describe('parseJsonLoose', () => {
    it('parses direct json', () => {
        expect(parseJsonLoose(' {"a":1} ')).toEqual({ a: 1 });
    });

    it('digs the outermost object out of surrounding noise', () => {
        expect(parseJsonLoose('log line\n{"a":1}\ntrailing')).toEqual({ a: 1 });
    });

    it('does not unwrap markdown fences', () => {
        // The fence's braces still get brace-scanned, but the leading ```json is
        // noise the loose parser is not asked to strip; the slice still works.
        expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('returns null when nothing parses', () => {
        expect(parseJsonLoose('no json here')).toBeNull();
    });
});

describe('extractJson', () => {
    it('parses direct json', () => {
        expect(extractJson(' {"a":1} ')).toEqual({ a: 1 });
    });

    it('unwraps fenced blocks', () => {
        expect(extractJson('noise\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 });
    });

    it('brace-scans as a last resort', () => {
        expect(extractJson('The result is {"a":1} thanks')).toEqual({ a: 1 });
    });

    it('returns null when nothing parses', () => {
        expect(extractJson('no json here')).toBeNull();
    });
});

describe('truncate', () => {
    it('clips past the limit and appends an ellipsis', () => {
        expect(truncate('abcdef', 3)).toBe('abc...');
        expect(truncate('ab', 3)).toBe('ab');
    });
});
