#!/usr/bin/env node

declare const __APP_VERSION__: string;

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeImage } from './analyzer.ts';
import {
    CONFIG_PATH,
    initConfigFile,
    loadConfigFile,
    renderEffectiveConfig,
    saveProviderBundle,
    setConfigValue,
    useProviderBundle,
} from './config.ts';
import { buildCooldownController, clearAllCooldowns, currentStatePath } from './cooldown.ts';
import { buildDoctorReport, renderDoctorReport } from './doctor.ts';
import { runGuard } from './guard/index.ts';
import { listProviders } from './providers/index.ts';
import { recoverPastedImages } from './recoverPaste/index.ts';
import { parseExtraBody } from './util/extraBody.ts';
import { readSecret } from './util/secretInput.ts';

const program = new Command();

/** Strict decimal parse: "10oops" is a typo, not 10. */
function parsePositiveInt(raw: string, flag: string): number {
    if (!/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) <= 0) {
        throw new Error(`Invalid ${flag}. Use a positive integer.`);
    }
    return Number.parseInt(raw, 10);
}

program
    .name('modlens')
    .description('Plug-in vision for text-only LLMs: image in, structured JSON evidence out')
    .version(__APP_VERSION__);

program
    .command('analyze', { isDefault: true })
    .description('Analyze an image into structured JSON evidence (default command)')
    .requiredOption('-i, --input <path|url>', 'Input image path or https URL')
    .option('-o, --output <path>', 'Write result JSON to a file')
    .option('-m, --model <name>', 'Provider model name')
    .option('-p, --provider <name>', `Vision provider (${listProviders().join(', ')})`)
    .option('--prompt <text>', 'Extra focus for this image')
    .option('--timeout <ms>', 'Provider timeout in milliseconds', '180000')
    .option('--provider-bin <path>', 'Provider binary path (default: agy)')
    .option('--workdir <path>', 'Working directory for the provider')
    .option(
        '--extra-body <json>',
        'JSON merged into the API request body, e.g. \'{"thinking":{"type":"disabled"}}\'',
    )
    .action(async (options) => {
        try {
            const timeoutMs = parsePositiveInt(options.timeout, '--timeout (milliseconds)');

            // Hard gate before any provider work, fed only by the explicit
            // MODLENS_MODEL env var and only when that model is identified:
            // a deny-pattern match or an allowlist exclusion blocks the read,
            // while storage sniffing and the denyWhenUnknown policy stay
            // advisory in `modlens guard`, where a wrong guess cannot block.
            const config = loadConfigFile();
            if (process.env.MODLENS_MODEL?.trim()) {
                const verdict = runGuard(config.guards, {
                    cwd: process.cwd(),
                    env: process.env,
                });
                if (verdict.guard === 'deny' && verdict.model) {
                    const cause = verdict.matched
                        ? `matches guards.denyModels pattern "${verdict.matched}". A model with native vision should read the image itself.`
                        : 'is not on guards.allowModels, which only lets listed models run the engine.';
                    throw new Error(
                        `Invocation guard denied this read: active model "${verdict.model}" ${cause} ` +
                            `To override, unset MODLENS_MODEL or edit guards in ${CONFIG_PATH}.`,
                    );
                }
            }

            const result = await analyzeImage({
                input: options.input,
                provider: options.provider,
                model: options.model,
                prompt: options.prompt,
                timeoutMs,
                providerBin: options.providerBin,
                workdir: options.workdir,
                extraBody: options.extraBody
                    ? parseExtraBody(options.extraBody, '--extra-body')
                    : undefined,
                config,
                cooldown: buildCooldownController(config),
            });

            const output = JSON.stringify(result, null, 2);

            if (options.output) {
                const outputPath = path.resolve(options.output);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, output, 'utf-8');
            }

            process.stdout.write(`${output}\n`);
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

program
    .command('recover-paste')
    .description(
        'Recover images pasted into Claude Code, Pi, or OpenCode from local session storage (they never hit disk otherwise)',
    )
    .option('--count <n>', 'How many recent pasted images to recover', '1')
    .option('--out-dir <path>', 'Directory to write recovered images to')
    .option(
        '--session <id>',
        'Claude Code session id for exact targeting (skills get it via ${CLAUDE_CODE_SESSION_ID})',
    )
    .option('--transcript <path>', 'Explicit transcript .jsonl or .db (overrides --session)')
    .option(
        '--harness <name>',
        'Force the storage scope: claude-code, pi, opencode, or none (default: auto-detect via process ancestry and env)',
    )
    .option('--cwd <path>', 'Project directory the image was pasted in', process.cwd())
    .action(async (options) => {
        try {
            const count = parsePositiveInt(options.count, '--count');
            const result = recoverPastedImages({
                count,
                outDir: options.outDir,
                transcript: options.transcript,
                session: options.session,
                cwd: options.cwd,
                harness: options.harness,
            });
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

program
    .command('guard')
    .description(
        'Check whether the vision engine should run for the active model (exit 0 allow, 1 deny, 2 error)',
    )
    .option(
        '--model <name>',
        "The calling agent's own model name; weakest signal, used when env and session storage say nothing",
    )
    .option('--cwd <path>', 'Project directory of the session', process.cwd())
    .action((options: { model?: string; cwd: string }) => {
        try {
            const verdict = runGuard(loadConfigFile().guards, {
                cwd: options.cwd,
                env: process.env,
                selfReported: options.model,
            });
            process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
            // exitCode, not exit(): exit() can drop the buffered verdict when
            // stdout is a pipe, and the JSON is the contract.
            process.exitCode = verdict.guard === 'deny' ? 1 : 0;
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 2;
        }
    });

program
    .command('doctor')
    .description(
        'Diagnose local config and routing (Node, providers, selection, harness) without spending quota or hitting the network',
    )
    .option('--json', 'Emit the report as JSON')
    .option('-p, --provider <name>', 'Show which provider this -p value would select')
    .action((options: { json?: boolean; provider?: string }) => {
        try {
            const report = buildDoctorReport({
                config: loadConfigFile(),
                env: process.env,
                providerFlag: options.provider,
                configPath: CONFIG_PATH,
                // Lets doctor name an installed skill copy that is older than
                // the CLI reporting on it (issue #33).
                version: __APP_VERSION__,
            });
            const output = options.json
                ? JSON.stringify(report, null, 2)
                : renderDoctorReport(report);
            process.stdout.write(`${output}\n`);
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

const config = program
    .command('config')
    .description(`Manage ${CONFIG_PATH} (providers, keys, models, proxies)`);

config
    .command('init')
    .description(`Create a starter config at ${CONFIG_PATH}`)
    .option('--force', 'Overwrite an existing config file')
    .action((options: { force?: boolean }) => {
        try {
            initConfigFile(CONFIG_PATH, Boolean(options.force));
            process.stdout.write(
                [
                    `Created ${CONFIG_PATH}`,
                    'Everything is optional. The usual ones:',
                    '  modlens config set provider <name>                      which provider analyzes images',
                    '  modlens config set cooldown on|off                       quota cooldown (on by default)',
                    '  modlens config set <provider>.<apiKey|baseUrl|model|proxy> <value>   provider settings',
                    '  modlens config set openai.proxy ""                  make one API provider connect directly',
                    '  modlens config set <provider>.extraBody \'{"thinking":{"type":"disabled"}}\'   vendor request fields',
                    '',
                ].join('\n'),
            );
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

config
    .command('save <slot> <label>')
    .description(
        'Snapshot a provider slot under a label (openai only), so switching gateways never loses a key',
    )
    .action((slot: string, label: string) => {
        try {
            const replaced = saveProviderBundle(slot, label);
            process.stdout.write(
                replaced
                    ? `Saved the ${slot} slot as "${label}", replacing the previous snapshot (${CONFIG_PATH})\n`
                    : `Saved the ${slot} slot as "${label}" in ${CONFIG_PATH}\n`,
            );
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

config
    .command('use <slot> <label>')
    .description(
        'Replace a provider slot with a saved copy, whole. Refuses to drop unsaved settings without --discard',
    )
    .option('--discard', 'Overwrite the current slot even though it is not saved under any label')
    .action((slot: string, label: string, options: { discard?: boolean }) => {
        try {
            useProviderBundle(slot, label, Boolean(options.discard));
            process.stdout.write(`The ${slot} slot now holds "${label}" (${CONFIG_PATH})\n`);
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

config
    .command('set <key> [value]')
    .description(
        'Set a value. Omit the value for an apiKey to enter it at a hidden prompt (out of argv and shell history), or to read one piped line (out of argv; the command feeding the pipe is yours to keep out of history)',
    )
    .action(async (key: string, value: string | undefined) => {
        try {
            let resolved = value;
            if (resolved === undefined) {
                // Only a secret earns the prompt: for anything else an
                // omitted value is a mistake, not a request for privacy.
                if (!key.endsWith('.apiKey')) {
                    throw new Error(`${key} needs a value: modlens config set ${key} <value>`);
                }
                resolved = await readSecret(`${key} (input hidden): `);
            }
            setConfigValue(key, resolved);
            process.stdout.write(`Saved ${key} to ${CONFIG_PATH}\n`);
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

config
    .command('show')
    .description('Print the effective config (file merged with env vars), credentials masked')
    .action(() => {
        try {
            process.stdout.write(`${renderEffectiveConfig(loadConfigFile())}\n`);
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

const state = program
    .command('state')
    .description('Manage the quota cooldown state at ~/.modlens/state.json');

state
    .command('clear')
    .description(
        'Forget every provider cooldown, so all providers are tried at full priority again',
    )
    .action(() => {
        try {
            const statePath = currentStatePath();
            clearAllCooldowns(statePath);
            process.stdout.write(`Cleared cooldown state (${statePath}).\n`);
        } catch (error) {
            process.stderr.write(
                `Error: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        }
    });

// Explicit argv and 'node' semantics: commander auto-detects Electron via
// process.versions.electron and then slices argv as if launched by a packaged
// app, which turns our script path into a stray positional ("too many
// arguments for 'analyze'", issue #25). This CLI is always spawned
// script-first (node dist/main.js, or an Electron binary running as node),
// so the node layout is the truth regardless of what binary hosts us.
await program.parseAsync(process.argv, { from: 'node' });
