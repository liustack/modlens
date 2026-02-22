import { describe, expect, it } from 'vitest';
import {
  buildGeminiInvocation,
  escapeAtPath,
  extractStructuredResponse,
  parseGeminiCliJsonOutput,
} from '../src/analyzer.ts';

describe('escapeAtPath', () => {
  it('escapes spaces and punctuation that break @path parsing', () => {
    const escaped = escapeAtPath('/tmp/cat 1(2)[x]{y}.png');
    expect(escaped).toBe('/tmp/cat\\ 1\\(2\\)\\[x\\]\\{y\\}.png');
  });
});

describe('buildGeminiInvocation', () => {
  it('builds gemini -p invocation with absolute image path and model', () => {
    const invocation = buildGeminiInvocation({
      imagePath: '/tmp/screenshots/my image(1).png',
      model: 'gemini-2.5-flash',
      geminiBin: 'gemini',
      workspaceDir: '/Users/leon/projects/modlens',
      extraPrompt: 'Focus on table headers',
    });

    expect(invocation.command).toBe('gemini');
    expect(invocation.args).toContain('-p');
    expect(invocation.args).toContain('--output-format');
    expect(invocation.args).toContain('json');
    expect(invocation.args).toContain('-m');
    expect(invocation.args).toContain('gemini-2.5-flash');

    const prompt = invocation.args[invocation.args.indexOf('-p') + 1] as string;
    expect(prompt).toContain('Analyze this image: /tmp/screenshots/my image(1).png');
    expect(prompt).toContain('Focus on table headers');

    expect(invocation.cwd).toBe('/Users/leon/projects/modlens');
  });

  it('defaults cwd to image directory for workspace-safe file access', () => {
    const invocation = buildGeminiInvocation({
      imagePath: '/Users/leon/pictures/cases/case-01.png',
      geminiBin: 'gemini',
    });

    expect(invocation.cwd).toBe('/Users/leon/pictures/cases');
  });
});

describe('parseGeminiCliJsonOutput', () => {
  it('parses non-interactive json output', () => {
    const parsed = parseGeminiCliJsonOutput(
      JSON.stringify({ session_id: 'sid', response: '{"summary":"ok"}', stats: { tokens: 1 } }),
    );

    expect(parsed.session_id).toBe('sid');
    expect(parsed.response).toBe('{"summary":"ok"}');
  });

  it('throws for invalid json output', () => {
    expect(() => parseGeminiCliJsonOutput('not json')).toThrow();
  });
});

describe('extractStructuredResponse', () => {
  it('extracts direct json response', () => {
    const result = extractStructuredResponse('{"summary":"ok"}');
    expect(result.structured).toEqual({ summary: 'ok' });
  });

  it('extracts json in fenced code block', () => {
    const result = extractStructuredResponse('```json\n{"summary":"ok"}\n```');
    expect(result.structured).toEqual({ summary: 'ok' });
  });

  it('returns raw text when response is not valid json', () => {
    const result = extractStructuredResponse('plain text response');
    expect(result.structured).toBeNull();
    expect(result.rawText).toBe('plain text response');
  });
});

describe('analyzeImage', () => {
  it('supports remote image url as input source', async () => {
    const invocation = buildGeminiInvocation({
      imagePath: 'https://example.com/demo.png',
      geminiBin: 'gemini',
    });

    const prompt = invocation.args[invocation.args.indexOf('-p') + 1] as string;
    expect(prompt).toContain('Analyze this image: https://example.com/demo.png');
    expect(invocation.cwd).toBe(process.cwd());
  });
});
