---
summary: 'Testing Guide: Vitest usage, co-located layout, conventions'
read_when:
  - Running tests
  - Writing tests
  - Troubleshooting test failures
---

# Testing Guide

## Layout

Tests are co-located with sources: every module gets an adjacent `*.test.ts` (for example `src/config.ts` and `src/config.test.ts`, `src/providers/geminiApi.ts` and `src/providers/geminiApi.test.ts`). There is no separate `test/` directory. Vite's lib build only follows the import graph from `src/main.ts`, so test files never enter `dist/`.

## Commands

```bash
pnpm test                                   # run everything
pnpm exec vitest run src/config.test.ts     # run a single file
pnpm typecheck                              # tsc --noEmit, run before tests
```

## Conventions

- No network in unit tests: stub `fetch` with `vi.stubGlobal('fetch', ...)` and clean up in `afterEach` via `vi.unstubAllGlobals()`.
- ESM module namespaces cannot be spied on (`vi.spyOn(fs, ...)` throws). Use real temp files via `fs.mkdtempSync(path.join(os.tmpdir(), ...))` and remove them in the test.
- To fake the home directory (config, transcripts), set `process.env.HOME` and restore it in `finally`; `os.homedir()` follows it on POSIX.
- Providers with subprocess transports test `buildInvocation`/`parseOutput` as pure functions; API providers test `execute` against a stubbed `fetch`, asserting both the request body and the parsed result.
- Real provider calls (agy, API keys, Claude login) are end-to-end verification, not unit tests. Keep them out of `pnpm test`.
