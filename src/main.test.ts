// The CLI assembly (arg parsing, validation branches, exit codes) only exists in
// the built bundle, since main.ts parses argv on import. These tests build once,
// then drive the real binary as a subprocess and assert on exit code and stderr.
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'main.js');

// The bound env vars leak into `config show`; strip them for a clean baseline.
const BOUND_ENV = [
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
];

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of BOUND_ENV) {
        delete env[key];
    }
    return { ...env, ...overrides };
}

function run(args: string[], env: Record<string, string> = {}) {
    const res = spawnSync('node', [cli, ...args], {
        encoding: 'utf-8',
        env: baseEnv(env),
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeAll(() => {
    // Always rebuild so the assembly under test is the current source, not a
    // stale dist left over from a previous run.
    execFileSync('pnpm', ['build'], { cwd: root, stdio: 'ignore' });
}, 120_000);

describe('analyze argument validation', () => {
    it('exits non-zero when the required --input is missing', () => {
        const { code, stderr } = run(['analyze']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/--input/);
    });

    it('rejects a non-numeric --timeout before doing any work', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cli-'));
        const file = path.join(dir, 'x.png');
        fs.writeFileSync(file, Buffer.from('bytes'));
        const { code, stderr } = run(['-i', file, '--timeout', 'abc']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/Invalid --timeout/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects an unsupported provider', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cli-'));
        const file = path.join(dir, 'x.png');
        fs.writeFileSync(file, Buffer.from('bytes'));
        const { code, stderr } = run(['-i', file, '-p', 'bogus-provider']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/Unsupported provider/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('recover-paste argument validation', () => {
    it('rejects a non-positive --count', () => {
        const { code, stderr } = run(['recover-paste', '--count', '0']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/Invalid --count/);
    });
});

describe('top-level wiring', () => {
    it('prints the version and exits 0', () => {
        const { code, stdout } = run(['--version']);
        expect(code).toBe(0);
        expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
});

describe('config show', () => {
    it('prints an empty effective config for a fresh home', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        const { code, stdout } = run(['config', 'show'], { HOME: home });
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ providers: {} });
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('merges a bound env var into the effective config, masked and tagged', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        const { code, stdout } = run(['config', 'show'], {
            HOME: home,
            GEMINI_API_KEY: 'AIzaSecretFromEnv12345',
        });
        expect(code).toBe(0);
        const parsed = JSON.parse(stdout) as {
            providers: Record<string, Record<string, string>>;
        };
        expect(parsed.providers['gemini-api'].apiKey).toMatch(/\(env\)$/);
        expect(parsed.providers['gemini-api'].apiKey).not.toContain('SecretFromEnv');
        fs.rmSync(home, { recursive: true, force: true });
    });
});
