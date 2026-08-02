import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeOpenaiCompat } from './openaiCompat.ts';

const structured = { summary: 'ok', uncertainty: [], ocr: { full_text: '', lines: [] } };
let tmpImage: string;

beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-oai-'));
    tmpImage = path.join(dir, 'x.png');
    fs.writeFileSync(tmpImage, Buffer.from('fake'));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const settings = { apiKey: 'sk-x', baseUrl: 'https://gw.example.com/v1', model: 'qwen3.6-27b' };

describe('executeOpenaiCompat', () => {
    it('demands baseUrl, apiKey, and model up front', async () => {
        await expect(
            executeOpenaiCompat({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKey: 'k' },
            }),
        ).rejects.toThrow('baseUrl, apiKey, and model');
    });

    it('sends a template-instance prompt, not a raw json schema', async () => {
        const calls: Array<{ init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            calls.push({ init });
            return new Response(
                JSON.stringify({ choices: [{ message: { content: JSON.stringify(structured) } }] }),
                { status: 200 },
            );
        });

        await executeOpenaiCompat({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings,
        });

        const body = JSON.parse(String(calls[0].init.body));
        const text = body.messages[0].content.find(
            (b: { type: string }) => b.type === 'text',
        ).text;
        expect(text).toContain('Fill this exact structure');
        expect(text).not.toContain('"type":"object"');
    });

    it('extracts fenced JSON from lax gateways', async () => {
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    JSON.stringify({
                        choices: [
                            {
                                message: {
                                    content: '```json\n' + JSON.stringify(structured) + '\n```',
                                },
                            },
                        ],
                        usage: { total_tokens: 5 },
                    }),
                    { status: 200 },
                ),
        );

        const parsed = await executeOpenaiCompat({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings,
        });
        expect(parsed.result).toEqual(structured);
    });

    it('fails loudly when the gateway returns schema-shaped or wrong JSON', async () => {
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    JSON.stringify({
                        choices: [
                            { message: { content: '{"type":"object","properties":{}}' } },
                        ],
                    }),
                    { status: 200 },
                ),
        );

        await expect(
            executeOpenaiCompat({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings,
            }),
        ).rejects.toThrow('does not match the vision schema');
    });
});
