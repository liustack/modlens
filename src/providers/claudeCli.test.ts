import { describe, expect, it } from 'vitest';
import { VISION_RESULT_SCHEMA } from '../schema.ts';
import { buildClaudeCliInvocation, parseClaudeCliOutput } from './claudeCli.ts';

describe('buildClaudeCliInvocation', () => {
    it('builds a Read-only claude print invocation with json schema', () => {
        const invocation = buildClaudeCliInvocation({
            imageSource: '/tmp/shots/pic.png',
            imageKind: 'local',
            timeoutMs: 60_000,
        });
        expect(invocation.command).toBe('claude');
        expect(invocation.args[invocation.args.indexOf('--allowedTools') + 1]).toBe('Read');
        expect(invocation.args).not.toContain('--dangerously-skip-permissions');
        expect(invocation.args[invocation.args.indexOf('--model') + 1]).toBe('haiku');
        const schemaArg = invocation.args[invocation.args.indexOf('--json-schema') + 1] as string;
        expect(JSON.parse(schemaArg)).toEqual(VISION_RESULT_SCHEMA);
        expect(invocation.cwd).toBe('/tmp/shots');
    });

    it('rejects remote urls with guidance', () => {
        expect(() =>
            buildClaudeCliInvocation({
                imageSource: 'https://example.com/a.png',
                imageKind: 'remote',
                timeoutMs: 1000,
            }),
        ).toThrow('local files only');
    });
});

describe('parseClaudeCliOutput', () => {
    const structured = { summary: 'ok', uncertainty: [] };

    it('parses the result envelope', () => {
        const parsed = parseClaudeCliOutput(
            JSON.stringify({
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: JSON.stringify(structured),
                session_id: 'sid',
                duration_ms: 11148,
                usage: { output_tokens: 328 },
            }),
        );
        expect(parsed.result).toEqual(structured);
        expect(parsed.meta.conversationId).toBe('sid');
        expect(parsed.meta.durationSeconds).toBeCloseTo(11.148);
    });

    it('throws on error envelopes and empty results', () => {
        expect(() =>
            parseClaudeCliOutput(
                JSON.stringify({ is_error: true, subtype: 'error', result: 'boom' }),
            ),
        ).toThrow('Claude CLI reported error');
        expect(() =>
            parseClaudeCliOutput(JSON.stringify({ subtype: 'success', result: '' })),
        ).toThrow('no result');
    });
});
