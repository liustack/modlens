#!/usr/bin/env node

declare const __APP_VERSION__: string;

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeImage } from './analyzer.ts';

const program = new Command();

program
    .name('modlens')
    .description('Plug-in vision for text-only LLMs: image in, structured JSON evidence out')
    .version(__APP_VERSION__)
    .requiredOption('-i, --input <path|url>', 'Input image path or https URL')
    .option('-o, --output <path>', 'Write result JSON to a file')
    .option('-m, --model <name>', 'Provider model name (default: gemini-3.6-flash-low)')
    .option('-p, --provider <name>', 'Vision provider name', 'antigravity-cli')
    .option('--prompt <text>', 'Extra focus for this image')
    .option('--timeout <ms>', 'Provider timeout in milliseconds', '180000')
    .option('--provider-bin <path>', 'Provider binary path (default: agy)')
    .option('--workdir <path>', 'Working directory for the provider command')
    .action(async (options) => {
        try {
            const timeoutMs = Number.parseInt(options.timeout, 10);
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                throw new Error('Invalid --timeout. Use a positive integer in milliseconds.');
            }

            const result = await analyzeImage({
                input: options.input,
                provider: options.provider,
                model: options.model,
                prompt: options.prompt,
                timeoutMs,
                providerBin: options.providerBin,
                workdir: options.workdir,
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
            process.exit(1);
        }
    });

program.parse();
