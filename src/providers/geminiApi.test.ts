import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeGeminiApi } from './geminiApi.ts';

const structured = { summary: 'ok', uncertainty: [] };
let tmpImage: string;

beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-gem-'));
    tmpImage = path.join(dir, 'x.png');
    fs.writeFileSync(tmpImage, Buffer.from('fake'));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('executeGeminiApi', () => {
    it('demands an api key up front', async () => {
        await expect(
            executeGeminiApi({ imageSource: tmpImage, imageKind: 'local', timeoutMs: 5000, settings: {} }),
        ).rejects.toThrow('GEMINI_API_KEY');
    });

    it('builds a generateContent call with responseJsonSchema and parses the output', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(
                JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }],
                    usageMetadata: { totalTokenCount: 9 },
                }),
                { status: 200 },
            );
        });

        const parsed = await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKey: 'AIzaTest' },
        });

        expect(calls[0].url).toContain('/v1beta/models/gemini-3.6-flash:generateContent');
        const body = JSON.parse(String(calls[0].init.body));
        expect(body.generationConfig.responseJsonSchema.required).toContain('summary');
        expect(body.contents[0].parts[0].inline_data.data).toBe(
            Buffer.from('fake').toString('base64'),
        );
        expect(parsed.result).toEqual(structured);
        expect(parsed.meta.usage).toEqual({ totalTokenCount: 9 });
    });

    it('surfaces api errors with status and body', async () => {
        vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));
        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKey: 'AIzaTest' },
            }),
        ).rejects.toThrow('Gemini API error 429');
    });
});
