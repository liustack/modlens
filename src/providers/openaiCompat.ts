// OpenAI-compatible provider: works with any /chat/completions endpoint that
// accepts image_url content (DashScope qwen-vl, OpenAI, GLM, ...). No portable
// schema enforcement across vendors, so the schema rides in the prompt and the
// response goes through tolerant JSON extraction.
import { readLocalImageBase64 } from '../imageInput.ts';
import { buildVisionPrompt } from '../prompt.ts';
import { extractJson, truncate } from '../util/json.ts';
import type {
    BuildProviderInvocationOptions,
    ProviderParsedOutput,
    VisionProvider,
} from './index.ts';

export async function executeOpenaiCompat(
    options: BuildProviderInvocationOptions,
): Promise<ProviderParsedOutput> {
    const apiKey = options.settings?.apiKey;
    const baseUrl = options.settings?.baseUrl?.replace(/\/$/, '');
    const model = options.model || options.settings?.model;

    if (!apiKey || !baseUrl || !model) {
        throw new Error(
            'openai provider needs baseUrl, apiKey, and model. Set OPENAI_BASE_URL and OPENAI_API_KEY, or run: modlens config set openai.baseUrl <url> / openai.apiKey <key> / openai.model <name>',
        );
    }

    const imageUrl =
        options.imageKind === 'remote'
            ? options.imageSource
            : toDataUrl(readLocalImageBase64(options.imageSource));

    // A filled-in template beats a JSON Schema here: weaker gateways tend to
    // echo a schema back instead of instantiating it.
    const prompt = `${buildVisionPrompt({
        imageSource: options.imageSource,
        imageKind: 'inline',
        extraPrompt: options.extraPrompt,
    })}

Respond with ONE JSON object only, no markdown fences, no commentary. Fill this exact structure with your findings from the image (do not repeat this template literally, replace every value):
{"summary":"one paragraph describing the image","ocr":{"full_text":"all visible text","lines":[{"text":"one line","language":"en"}]},"layout":{"regions":[{"type":"title|subtitle|paragraph|list|table|chart|form|code|image|icon|other","reading_order":1,"text":"region text"}]},"semantics":{"scene":"what kind of scene","intent":"what the image is for","entities":[{"name":"entity","type":"kind","evidence":"where seen"}],"relations":[{"subject":"a","predicate":"relates to","object":"b"}]},"visual":{"dominant_colors":["color"],"style":"visual style","notes":["notable visual detail"]},"uncertainty":["anything unreadable or ambiguous"]}`;

    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: imageUrl } },
                        { type: 'text', text: prompt },
                    ],
                },
            ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI-compatible API error ${response.status}: ${truncate(body)}`);
    }

    const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
    };

    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error('OpenAI-compatible API returned no message content.');
    }

    const result = extractJson(text);
    if (result === null) {
        throw new Error(`OpenAI-compatible API returned non-JSON output: ${truncate(text)}`);
    }
    // No portable server-side schema enforcement on this route, so verify the
    // shape instead of silently returning something that only looks right.
    // Checking only top-level keys still let {"ocr":{}} through, so the model
    // received an empty shell that looked like evidence.
    const missing = missingSchemaFields(result);
    if (missing.length > 0) {
        throw new Error(
            `OpenAI-compatible API returned JSON that does not match the vision schema (missing: ${missing.join(', ')}). Retry, or switch to gemini-api / anthropic for enforced schemas. Got: ${truncate(text)}`,
        );
    }

    return {
        result,
        meta: {
            conversationId: null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usage ?? null,
        },
    };
}

/**
 * Required fields the vision contract promises, nested ones included. Returns
 * the paths that are absent or the wrong type.
 */
export function missingSchemaFields(result: unknown): string[] {
    const missing: string[] = [];
    const root = (result ?? {}) as Record<string, unknown>;
    const child = (key: string) =>
        (root[key] && typeof root[key] === 'object' ? root[key] : {}) as Record<string, unknown>;

    const expect = (path: string, ok: boolean) => {
        if (!ok) {
            missing.push(path);
        }
    };

    expect('summary', typeof root.summary === 'string');
    expect('ocr', typeof root.ocr === 'object' && root.ocr !== null);
    expect('ocr.full_text', typeof child('ocr').full_text === 'string');
    expect('ocr.lines', Array.isArray(child('ocr').lines));
    expect('layout', typeof root.layout === 'object' && root.layout !== null);
    expect('layout.regions', Array.isArray(child('layout').regions));
    expect('semantics', typeof root.semantics === 'object' && root.semantics !== null);
    expect('semantics.scene', typeof child('semantics').scene === 'string');
    expect('semantics.entities', Array.isArray(child('semantics').entities));
    expect('visual', typeof root.visual === 'object' && root.visual !== null);
    expect('uncertainty', Array.isArray(root.uncertainty));

    return missing;
}

function toDataUrl(image: { data: string; mimeType: string }): string {
    return `data:${image.mimeType};base64,${image.data}`;
}

export const openaiCompatProvider: VisionProvider = {
    name: 'openai',
    defaultModel: '',
    execute: executeOpenaiCompat,
};
