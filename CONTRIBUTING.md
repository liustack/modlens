# Contributing to ModLens

Thanks for helping. This is a small, focused tool, so the bar is simple: keep it working, keep it honest, keep changes reviewable.

## Scope

ModLens does one thing: turn an image into structured JSON evidence for text-only models. Web search and page fetching live in a sibling project ([ModSearch](https://github.com/liustack/modsearch)), not here. Features that widen the mandate are likely to be declined, so open an issue to discuss direction before a large change.

## Setup

```bash
pnpm install
pnpm test        # vitest, all suites
pnpm typecheck   # tsc --noEmit
pnpm build       # must produce a single dist/main.js
```

Requires Node 18+ (22.5+ if you touch OpenCode paste recovery, which needs `node:sqlite`).

## Tests

- Tests are co-located: a module lives beside its `*.test.ts`. New behavior or a bug fix ships with a test in the same commit.
- No network in unit tests. Stub `fetch` with `vi.stubGlobal('fetch', ...)` and clean up in `afterEach`.
- ESM namespaces cannot be spied on, so use real temp files (`fs.mkdtempSync`) and remove them in the test. Fake `$HOME` for config and transcript paths, and restore it in `finally`.
- Real provider calls (agy, API keys, a Claude login) are end-to-end checks, not unit tests. Keep them out of `pnpm test`.

More detail lives in [docs/testing.md](docs/testing.md).

## Commits

- [Conventional Commits](https://www.conventionalcommits.org): `type(scope): imperative summary`, no trailing period, summary under ~72 chars.
- One commit does one thing, and the tree still builds and tests after each. Do not mix a refactor or a reformat with a behavior change.
- Include the test in the same commit as the behavior it covers.

Full conventions are in [docs/commit.md](docs/commit.md).

## Style

- 4-space indentation, enforced by Biome. Run `pnpm format` before committing and `pnpm lint` to check.
- Keep a reformat in its own commit, separate from logic.

## Pull requests

- Green `pnpm typecheck && pnpm test && pnpm build && pnpm lint` before you open it.
- Describe what changed and why. Link the issue it closes.
- If you changed behavior a user can see, say so, and update the README (both `README.md` and `README.zh-CN.md`, which must stay aligned) and any affected doc.

The broader design notes for working on this codebase are in [AGENTS.md](AGENTS.md).
