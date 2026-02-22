#!/usr/bin/env node

declare const __APP_VERSION__: string;

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeImage } from './analyzer.ts';

const program = new Command();

program
    .name('modlens')
    .description('Image-to-text visual bridge for non-vision LLM workflows')
    .version(__APP_VERSION__)
    .requiredOption('-i, --input <path>', 'Input image path')
    .option('-o, --output <path>', 'Write result JSON to a file')
    .option('-m, --model <name>', 'Gemini model name')
    .option('--prompt <text>', 'Extra prompt constraints for this image')
    .option('--timeout <ms>', 'Command timeout in milliseconds', '180000')
    .option('--gemini-bin <path>', 'Gemini CLI binary path', 'gemini')
    .action(async (options) => {
        try {
            const timeoutMs = Number.parseInt(options.timeout, 10);
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                throw new Error('Invalid --timeout. Use a positive integer in milliseconds.');
            }

            const result = await analyzeImage({
                input: options.input,
                model: options.model,
                prompt: options.prompt,
                timeoutMs,
                geminiBin: options.geminiBin,
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
