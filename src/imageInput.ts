import * as fs from 'fs';
import * as path from 'path';

const MIME_BY_EXT: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
};

export function mimeTypeFor(source: string): string {
    // Local paths go straight through path.extname. Routing them through new URL
    // truncated the extension at a literal # or ? (a fragment/query only exists
    // in URLs), so /tmp/shot#2.png fell back to image/jpeg. Only remote URLs,
    // where a query string is real, get URL parsing.
    const ext = /^https?:\/\//i.test(source)
        ? path.extname(new URL(source).pathname).toLowerCase()
        : path.extname(source).toLowerCase();
    return MIME_BY_EXT[ext] ?? 'image/jpeg';
}

export function readLocalImageBase64(filePath: string): { data: string; mimeType: string } {
    const data = fs.readFileSync(filePath).toString('base64');
    return { data, mimeType: mimeTypeFor(filePath) };
}

/** Download a remote image, for APIs that only accept inline bytes. */
export async function fetchRemoteImageBase64(
    url: string,
    timeoutMs: number,
): Promise<{ data: string; mimeType: string }> {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        throw new Error(`Failed to download image (${response.status}): ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    return {
        data: buffer.toString('base64'),
        mimeType: contentType?.startsWith('image/') ? contentType : mimeTypeFor(url),
    };
}
