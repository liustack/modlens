// Claude API provider. Structured output enforced the Anthropic way: a forced
// tool call whose input_schema is the vision result schema.
import { readLocalImageBase64 } from '../imageInput.ts';
import { buildVisionPrompt } from '../prompt.ts';
import { VISION_RESULT_SCHEMA } from '../schema.ts';
import { truncate } from '../util/json.ts';
import type {
    BuildProviderInvocationOptions,
    ProviderParsedOutput,
    VisionProvider,
} from './index.ts';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const TOOL_NAME = 'report_vision_evidence';

export async function executeAnthropicApi(
    options: BuildProviderInvocationOptions,
): Promise<ProviderParsedOutput> {
    const apiKey = options.settings?.apiKey;
    if (!apiKey) {
        throw new Error(
            'anthropic provider needs an API key. Set ANTHROPIC_API_KEY, or run: modlens config set anthropic.apiKey <key>',
        );
    }

    const model = options.model || options.settings?.model || ANTHROPIC_DEFAULT_MODEL;
    const baseUrl = (options.settings?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');

    const imageSource =
        options.imageKind === 'remote'
            ? { type: 'url' as const, url: options.imageSource }
            : (() => {
                  const image = readLocalImageBase64(options.imageSource);
                  return {
                      type: 'base64' as const,
                      media_type: image.mimeType,
                      data: image.data,
                  };
              })();

    const prompt = `${buildVisionPrompt({
        imageSource: options.imageSource,
        imageKind: 'inline',
        extraPrompt: options.extraPrompt,
    })}

Report your findings by calling the ${TOOL_NAME} tool.`;

    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: 4096,
            tools: [
                {
                    name: TOOL_NAME,
                    description: 'Report the structured visual evidence extracted from the image.',
                    input_schema: VISION_RESULT_SCHEMA,
                },
            ],
            tool_choice: { type: 'tool', name: TOOL_NAME },
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image', source: imageSource },
                        { type: 'text', text: prompt },
                    ],
                },
            ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${truncate(body)}`);
    }

    const payload = (await response.json()) as {
        content?: Array<{ type: string; input?: unknown }>;
        usage?: unknown;
    };

    const toolUse = payload.content?.find((block) => block.type === 'tool_use');
    if (!toolUse?.input) {
        throw new Error('Anthropic API returned no tool_use block.');
    }

    return {
        result: toolUse.input,
        meta: {
            conversationId: null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usage ?? null,
        },
    };
}

export const anthropicApiProvider: VisionProvider = {
    name: 'anthropic',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    execute: executeAnthropicApi,
};
