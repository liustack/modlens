import { describe, expect, it } from 'vitest';
import { harnessFromPsTable } from './detect.ts';

describe('harness detection (process ancestry)', () => {
    function psTable(rows: Array<[number, number, string]>): string {
        return rows.map(([pid, ppid, command]) => ` ${pid} ${ppid} ${command}`).join('\n');
    }

    it('finds the nearest harness ancestor by executable basename', () => {
        const ps = psTable([
            [100, 1, '/usr/local/bin/node --no-warnings /Users/x/.claude/local/claude'],
            [200, 100, '/bin/zsh -c modlens'],
            [300, 200, 'node /Users/x/projects/modlens/dist/main.js recover-paste'],
        ]);
        expect(harnessFromPsTable(ps, 300)).toBe('claude-code');
    });

    it('resolves nesting to the innermost harness', () => {
        // opencode launched from inside a Claude Code bash: opencode is nearer.
        const ps = psTable([
            [100, 1, 'node /Users/x/.claude/local/claude'],
            [200, 100, '/bin/zsh -c "opencode run ..."'],
            [300, 200, '/Users/x/.cache/opencode/bin/opencode run analyze'],
            [400, 300, '/bin/sh -c modlens'],
            [500, 400, 'node /Users/x/modlens/dist/main.js recover-paste'],
        ]);
        expect(harnessFromPsTable(ps, 500)).toBe('opencode');
    });

    it('ignores free-text arguments beyond the leading tokens', () => {
        const ps = psTable([
            [100, 1, '/opt/homebrew/bin/fish'],
            [
                200, 100,
                'sometool serve --flag a b c d e f "please check the pi and opencode docs"',
            ],
            [300, 200, 'node dist/main.js recover-paste'],
        ]);
        expect(harnessFromPsTable(ps, 300)).toBeNull();
    });

    it('returns null for terminals with no harness ancestor', () => {
        const ps = psTable([
            [100, 1, '/opt/homebrew/bin/fish'],
            [300, 100, 'node dist/main.js recover-paste'],
        ]);
        expect(harnessFromPsTable(ps, 300)).toBeNull();
    });

    it('only reads the executable name from process ancestry', () => {
        // A command that merely mentions "pi" in its arguments is not Pi.
        const ps = [
            ' 100 1 /opt/homebrew/bin/fish',
            ' 200 100 sometool serve --note "check the pi docs" pi',
            ' 300 200 node /x/dist/main.js recover-paste',
        ].join('\n');
        expect(harnessFromPsTable(ps, 300)).toBeNull();

        const real = [
            ' 100 1 /usr/local/bin/node /Users/x/.npm/bin/pi',
            ' 300 100 node /x/dist/main.js recover-paste',
        ].join('\n');
        expect(harnessFromPsTable(real, 300)).toBe('pi');
    });
});
