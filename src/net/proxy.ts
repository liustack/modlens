// Proxy support for the inline API providers (issue #20). Node's fetch
// (undici) ignores HTTP_PROXY/HTTPS_PROXY entirely, so machines that reach
// the internet through a proxy could not use gemini-api at all and the
// failure surfaced as a bare "fetch failed". Scope is deliberate: only the
// API request paths take a proxy dispatcher. The remote-image download path
// keeps its own IP-pinned dispatcher, because its SSRF guards validate the
// exact address being connected to, and routing it through a proxy would
// bypass that boundary.
import type { Dispatcher } from 'undici';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * The dispatcher an API provider request should use. A non-empty explicit
 * setting selects that proxy, while an explicit empty string selects a direct
 * connection. Only an absent setting inherits the standard environment
 * variables, with NO_PROXY included. Undefined means direct connection,
 * fetch's default behavior.
 */
export function apiProxyDispatcher(
    explicitProxy: string | undefined,
    env: NodeJS.ProcessEnv,
): Dispatcher | undefined {
    if (explicitProxy !== undefined) {
        const proxy = explicitProxy.trim();
        return proxy ? new ProxyAgent(proxy) : undefined;
    }
    if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
        return new EnvHttpProxyAgent();
    }
    return undefined;
}

// undici tags network-level failures with these cause codes; anything else
// (JSON errors, aborts, HTTP statuses) is not a connectivity problem.
const CONNECT_CODES = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
]);

/**
 * An actionable message for a request that never reached the network, or null
 * when the error is not a connectivity failure. "fetch failed" alone gives a
 * proxied user no way to tell a bad key from an unreachable endpoint.
 */
export function connectFailureHint(error: unknown, url: string): string | null {
    const cause =
        error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
    if (!cause?.code || !CONNECT_CODES.has(cause.code)) {
        return null;
    }
    let host: string;
    try {
        host = new URL(url).host;
    } catch {
        return null;
    }
    return (
        `Could not connect to ${host} (${cause.code}). The request never reached the network. ` +
        'If this machine reaches the internet through a proxy, set HTTPS_PROXY/HTTP_PROXY, ' +
        'or run: modlens config set proxy <url>'
    );
}

/**
 * fetch for API provider requests: routes through the configured proxy when
 * one applies, and turns a bare "fetch failed" connect error into the
 * actionable proxy hint.
 */
export async function apiFetch(
    url: string,
    init: RequestInit,
    proxy: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
    const dispatcher = apiProxyDispatcher(proxy, env) ?? new Agent();
    try {
        // Dispatcher and fetch must come from the SAME undici: handing npm
        // undici's Agent to the host fetch (a different undici major) fails
        // with UND_ERR_INVALID_ARG (issue #23). Importing npm undici occupies
        // the shared undici.globalDispatcher.2 slot, and Node 26.0.0 host
        // fetch plus npm 8.10.0 Agent on HTTP/2 drops headers (issue #91),
        // so the no-proxy path uses undiciFetch too.
        const response = (await undiciFetch(url, {
            ...(init as Parameters<typeof undiciFetch>[1]),
            dispatcher,
        })) as unknown as Response;
        // Buffer the body before closing: close() waits for in-flight
        // requests, and a kept-alive pool would otherwise pin the event
        // loop so the CLI never exits (exitCode relies on loop drain).
        try {
            const buffered = Buffer.from(await response.arrayBuffer());
            await dispatcher.close();
            return new Response(buffered, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } catch (bodyError) {
            // Status already arrived. A truncated body is not a connect
            // failure: providers classify 401/429 from status, and
            // connectFailureHint would mislabel ECONNRESET as "never
            // reached the network". Close the pool, then hand the original
            // error to text()/json().
            await dispatcher.close().catch(() => {});
            return bodyFailedResponse(response, bodyError);
        }
    } catch (error) {
        await dispatcher.close().catch(() => {});
        const hint = connectFailureHint(error, url);
        throw hint ? new Error(hint, { cause: error }) : error;
    }
}

/** A Response whose status and headers survived, but whose body methods reject. */
function bodyFailedResponse(response: Response, error: unknown): Response {
    const cause = error instanceof Error ? error : new Error(String(error));
    return new Response(
        new ReadableStream({
            start(controller) {
                controller.error(cause);
            },
        }),
        {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        },
    );
}
