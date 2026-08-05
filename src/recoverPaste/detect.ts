// Harness detection.
//
// Recovery must read the storage of the harness this command is actually
// running inside; racing every store by timestamp lets one tool's stale
// sessions hijack another tool's paste. The primary signal is the process
// ancestry: the nearest known harness among our parent processes is the one
// that spawned this command, which also resolves nested setups (opencode
// launched from inside Claude Code) to the innermost harness, the one whose
// input box received the paste. Env fingerprints are the fallback: Claude Code
// injects CLAUDECODE/CLAUDE_CODE_SESSION_ID, pi sets PI_CODING_AGENT, codex
// injects CODEX_THREAD_ID; opencode injects nothing, which is exactly why
// ancestry comes first.
import * as childProcess from 'child_process';
import * as path from 'path';

const HARNESS_BY_BASENAME: Record<string, string> = {
    claude: 'claude-code',
    'claude-code': 'claude-code',
    pi: 'pi',
    opencode: 'opencode',
    codex: 'codex',
};

/** Walk the ppid chain in a `ps -Ao pid=,ppid=,command=` table, nearest first. */
export function harnessFromPsTable(psOutput: string, startPid: number): string | null {
    const table = new Map<number, { ppid: number; command: string }>();
    for (const line of psOutput.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match) {
            table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
        }
    }
    let pid: number | undefined = table.get(startPid)?.ppid;
    for (let hops = 0; hops < 50 && pid !== undefined && pid > 1; hops++) {
        const proc = table.get(pid);
        if (!proc) {
            return null;
        }
        // Only the executable itself, plus the script path when it is run
        // through a node shim. Scanning further matched plain arguments: a
        // command that merely mentioned "pi" was detected as Pi.
        const tokens = proc.command.trim().split(/\s+/);
        const candidates = [tokens[0]];
        if (/^(node|bun|deno)$/.test(path.basename(tokens[0] ?? ''))) {
            // A flag's value is not the script: `node --require pi app.js` used
            // to be read as Pi. Take the first token that looks like a path to
            // a script file.
            const script = tokens
                .slice(1)
                .find((token) => !token.startsWith('-') && /[/\\]|\.(m|c)?[jt]s$/.test(token));
            if (script) {
                candidates.push(script);
            }
        }
        for (const token of candidates) {
            const mapped = token ? HARNESS_BY_BASENAME[path.basename(token)] : undefined;
            if (mapped) {
                return mapped;
            }
        }
        pid = proc.ppid;
    }
    return null;
}

export function detectHarness(): string | null {
    const override = process.env.MODLENS_HARNESS;
    if (override) {
        return override === 'none' ? null : override;
    }
    try {
        const ps = childProcess.execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], {
            encoding: 'utf-8',
            maxBuffer: 16 * 1024 * 1024,
        });
        const found = harnessFromPsTable(ps, process.pid);
        if (found) {
            return found;
        }
    } catch {
        // ps unavailable (e.g. Windows): fall through to env fingerprints
    }
    if (process.env.PI_CODING_AGENT) {
        return 'pi';
    }
    if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) {
        return 'codex';
    }
    if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) {
        return 'claude-code';
    }
    return null;
}
