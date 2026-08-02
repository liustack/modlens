import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeAnthropicApi } from './anthropicApi.ts';

const structured = { summary: 'ok', uncertainty: [] };
let tmpImage: string;

beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-ant-'));
    tmpImage = path.join(dir, 'x.png');
    fs.writeFileSync(tmpImage, Buffer.from('fake'));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('executeAnthropicApi', () => {
    it('demands an api key up front', async () => {
        await expect(
            executeAnthropicApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: {},
            }),
        ).rejects.toThrow('ANTHROPIC_API_KEY');
    });

    it('forces a tool call with the vision schema and reads tool_use input', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(
                JSON.stringify({
                    content: [{ type: 'tool_use', input: structured }],
                    usage: { input_tokens: 3 },
                }),
                { status: 200 },
            );
        });

        const parsed = await executeAnthropicApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKey: 'sk-ant' },
        });

        expect(calls[0].url).toContain('/v1/messages');
        const body = JSON.parse(String(calls[0].init.body));
        expect(body.model).toBe('claude-haiku-4-5-20251001');
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'report_vision_evidence' });
        expect(body.tools[0].input_schema.required).toContain('ocr');
        expect(body.messages[0].content[0].source.type).toBe('base64');
        expect(parsed.result).toEqual(structured);
    });

    it('passes remote urls through as url sources', async () => {
        const calls: Array<{ init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            calls.push({ init });
            return new Response(
                JSON.stringify({ content: [{ type: 'tool_use', input: structured }] }),
                { status: 200 },
            );
        });

        await executeAnthropicApi({
            imageSource: 'https://x.example.com/a.png',
            imageKind: 'remote',
            timeoutMs: 5000,
            settings: { apiKey: 'sk-ant' },
        });
        const body = JSON.parse(String(calls[0].init.body));
        expect(body.messages[0].content[0].source).toEqual({
            type: 'url',
            url: 'https://x.example.com/a.png',
        });
    });

    it('throws when no tool_use block comes back', async () => {
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(JSON.stringify({ content: [{ type: 'text', text: 'chatty' }] }), {
                    status: 200,
                }),
        );
        await expect(
            executeAnthropicApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKey: 'sk-ant' },
            }),
        ).rejects.toThrow('no tool_use block');
    });
});
