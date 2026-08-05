// Shared JSON helpers. Every provider needs the same three moves: parse JSON
// without throwing, dig a JSON object out of chatty output, and truncate a long
// blob for an error message. They used to be copy-pasted into each provider,
// which drifted the moment one copy was touched.

/** Parse JSON, returning null instead of throwing. */
export function tryParseJson(text: string): unknown | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Parse JSON, first as-is, then from the outermost {...} slice. Enough for CLIs
 * that wrap their JSON envelope in a line of log noise, but not markdown fences.
 */
export function parseJsonLoose(text: string): unknown | null {
    const trimmed = text.trim();
    const direct = tryParseJson(trimmed);
    if (direct !== null) {
        return direct;
    }
    return parseBraceSlice(trimmed);
}

/**
 * Best-effort JSON extraction for APIs without enforced structured output: tries
 * a direct parse, then a ```json fenced block, then the outermost {...} slice.
 */
export function extractJson(text: string): unknown | null {
    const trimmed = text.trim();

    const direct = tryParseJson(trimmed);
    if (direct !== null) {
        return direct;
    }

    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenced) {
        const parsed = tryParseJson(fenced[1].trim());
        if (parsed !== null) {
            return parsed;
        }
    }

    return parseBraceSlice(trimmed);
}

function parseBraceSlice(trimmed: string): unknown | null {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
        return tryParseJson(trimmed.slice(first, last + 1));
    }
    return null;
}

/** Shorten a blob for an error message, appending an ellipsis when clipped. */
export function truncate(text: string, max = 300): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}
