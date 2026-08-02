// OpenAI-compatible provider: works with any /chat/completions endpoint that
// accepts image_url content (DashScope qwen-vl, OpenAI, GLM, ...). No portable
// schema enforcement across vendors, so the schema rides in the prompt and the
// response goes through tolerant JSON extraction.
import { extractJson, fetchRemoteImageBase64, readLocalImageBase64 } from '../imageInput.ts';
import { buildVisionPrompt } from '../prompt.ts';
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
    const shaped = result as { summary?: unknown; ocr?: unknown };
    if (typeof shaped.summary !== 'string' || typeof shaped.ocr !== 'object') {
        throw new Error(
            `OpenAI-compatible API returned JSON that does not match the vision schema (missing summary/ocr). Retry, or switch to gemini-api / anthropic for enforced schemas. Got: ${truncate(text)}`,
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

function toDataUrl(image: { data: string; mimeType: string }): string {
    return `data:${image.mimeType};base64,${image.data}`;
}

// Remote URLs are passed through untouched; some gateways cannot fetch
// arbitrary URLs, in which case download-and-inline happens at call time.
export async function remoteAsDataUrl(url: string, timeoutMs: number): Promise<string> {
    return toDataUrl(await fetchRemoteImageBase64(url, timeoutMs));
}

function truncate(text: string): string {
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

export const openaiCompatProvider: VisionProvider = {
    name: 'openai',
    defaultModel: '',
    execute: executeOpenaiCompat,
};
