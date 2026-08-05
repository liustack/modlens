import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    buildAntigravityInvocation,
    DEFAULT_MODEL,
    describeAntigravityFailure,
    parseAntigravityOutput,
} from './antigravity.ts';
import { VISION_RESULT_SCHEMA } from '../schema.ts';

describe('buildAntigravityInvocation', () => {
    it('builds agy print invocation with schema-enforced json output', () => {
        const invocation = buildAntigravityInvocation({
            imageSource: '/tmp/screenshots/my image(1).png',
            imageKind: 'local',
            model: 'gemini-3.1-pro-high',
            extraPrompt: 'Focus on table headers',
            timeoutMs: 120_000,
        });

        expect(invocation.command).toBe('agy');
        expect(invocation.args).toContain('--dangerously-skip-permissions');
        expect(invocation.args).toContain('--output-format');
        expect(invocation.args).toContain('json');
        expect(invocation.args).toContain('gemini-3.1-pro-high');
        expect(invocation.args[invocation.args.indexOf('--print-timeout') + 1]).toBe('120s');

        const schemaArg = invocation.args[invocation.args.indexOf('--json-schema') + 1] as string;
        expect(JSON.parse(schemaArg)).toEqual(VISION_RESULT_SCHEMA);

        const prompt = invocation.args[invocation.args.indexOf('-p') + 1] as string;
        expect(prompt).toContain(
            'Read the image file at this path and analyze it: /tmp/screenshots/my image(1).png',
        );
        expect(prompt).toContain('Focus on table headers');
        expect(invocation.cwd).toBe('/tmp/screenshots');
    });

    it('uses the default model and a fetch prompt for remote images', () => {
        const invocation = buildAntigravityInvocation({
            imageSource: 'https://example.com/demo.png',
            imageKind: 'remote',
            timeoutMs: 180_000,
        });

        expect(invocation.args).toContain(DEFAULT_MODEL);
        const prompt = invocation.args[invocation.args.indexOf('-p') + 1] as string;
        expect(prompt).toContain(
            'Fetch the image at this URL and analyze it: https://example.com/demo.png',
        );
        expect(invocation.cwd).toBe(process.cwd());
    });
});

describe('parseAntigravityOutput', () => {
    const structured = { summary: 'ok', uncertainty: [] };

    it('prefers structured_output from the envelope', () => {
        const parsed = parseAntigravityOutput(
            JSON.stringify({
                conversation_id: 'cid',
                status: 'SUCCESS',
                response: JSON.stringify(structured),
                structured_output: structured,
                duration_seconds: 12.3,
                usage: { total_tokens: 42 },
            }),
        );

        expect(parsed.result).toEqual(structured);
        expect(parsed.meta.conversationId).toBe('cid');
        expect(parsed.meta.durationSeconds).toBe(12.3);
        expect(parsed.meta.usage).toEqual({ total_tokens: 42 });
    });

    it('falls back to parsing the response string', () => {
        const parsed = parseAntigravityOutput(
            JSON.stringify({ status: 'SUCCESS', response: JSON.stringify(structured) }),
        );
        expect(parsed.result).toEqual(structured);
    });

    it('throws on non-success status and on missing results', () => {
        expect(() =>
            parseAntigravityOutput(JSON.stringify({ status: 'FAILED', response: '' })),
        ).toThrow('status FAILED');
        expect(() =>
            parseAntigravityOutput(JSON.stringify({ status: 'SUCCESS', response: '' })),
        ).toThrow('no structured result');
    });

    it('recovers the envelope from noisy stdout and rejects garbage', () => {
        const noisy = `WARN something\n${JSON.stringify({
            status: 'SUCCESS',
            structured_output: structured,
        })}`;
        expect(parseAntigravityOutput(noisy).result).toEqual(structured);
        expect(() => parseAntigravityOutput('not json')).toThrow(
            'Failed to parse Antigravity CLI JSON output.',
        );
    });
});

describe('describeAntigravityFailure', () => {
    const realHome = process.env.HOME;
    let fakeHome: string;

    beforeEach(() => {
        // Isolate from this machine's real agy logs.
        fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-agy-'));
        process.env.HOME = fakeHome;
    });

    afterEach(() => {
        process.env.HOME = realHome;
        fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    function writeAgyLog(contents: string): void {
        const dir = path.join(fakeHome, '.gemini', 'antigravity-cli', 'log');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'cli-20260805.log'), contents);
    }

    const errorEnvelope = (error: string, totalTokens = 0) =>
        JSON.stringify({
            status: 'ERROR',
            response: '',
            error,
            usage: { total_tokens: totalTokens },
        });

    it('explains a locked keyring when agy logs an auth failure', () => {
        // agy's own envelope is generic here: the real cause is only in its log.
        writeAgyLog(
            'Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.',
        );
        const message = describeAntigravityFailure({
            stdout: errorEnvelope('Agent execution terminated due to error.'),
            stderr: '',
            code: 1,
        });
        expect(message).toContain('cannot read its stored login token');
        expect(message).toContain('keyring is locked');
        expect(message).toContain('modlens config set provider gemini-api');
    });

    it('explains an exhausted quota and keeps agy own wording', () => {
        const message = describeAntigravityFailure({
            stdout: errorEnvelope('Individual quota reached. Resets in 94h19m9s.'),
            stderr: '',
            code: 1,
        });
        expect(message).toContain('Resets in 94h19m9s');
        expect(message).toContain('weekly bucket');
        expect(message).toContain('modlens config set provider gemini-api');
    });

    it('falls back to a generic did-no-work message with the log path', () => {
        const message = describeAntigravityFailure({
            stdout: errorEnvelope(''),
            stderr: '',
            code: 1,
        });
        expect(message).toContain('no tokens consumed');
        expect(message).toContain('antigravity-cli/log');
    });

    it('stays out of the way when agy never ran at all', () => {
        // No envelope means the failure came from somewhere else, and agy's
        // logs would only misdiagnose it.
        expect(
            describeAntigravityFailure({ stdout: 'not json at all', stderr: '', code: 127 }),
        ).toBeNull();
    });

    it('ignores stale logs from earlier runs', () => {
        writeAgyLog('error getting token source: You are not logged into Antigravity.');
        const logFile = path.join(
            fakeHome,
            '.gemini',
            'antigravity-cli',
            'log',
            'cli-20260805.log',
        );
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        fs.utimesSync(logFile, hourAgo, hourAgo);

        const message = describeAntigravityFailure({
            stdout: errorEnvelope('Agent execution terminated due to error.'),
            stderr: '',
            code: 1,
        });
        expect(message).not.toContain('keyring is locked');
        expect(message).toContain('Agent execution terminated');
    });
});
