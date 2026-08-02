# Project Overview (for AI Agent)

## Goal

Provide the `modlens` CLI tool that converts image sources (local path or remote URL) into structured text evidence for non-vision LLM workflows.

## Technical Approach

- **Five vision providers behind one interface** (`src/providers/index.ts`). Subprocess providers implement `buildInvocation` + `parseOutput` (antigravity-cli, claude-cli); in-process API providers implement `execute` (gemini-api, openai, anthropic). `antigravity-cli` is the zero-config default.
- **Schema-enforced JSON output** wherever the backend allows: `--json-schema` on the two CLIs, `responseJsonSchema` on gemini-api, a forced tool call on anthropic. The openai route uses a template-instance prompt (weak gateways echo raw schemas back) plus shape validation that fails loudly.
- **Layered config**: CLI flags > env vars (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`) > `~/.modlens/config.json` (managed by `modlens config init/set/show`, 0600, masked rendering) > built-ins.
- **Claude Code paste recovery**: `modlens recover-paste` pulls pasted image bytes out of `~/.claude/projects/<cwd-slug>/<session>.jsonl` (pastes never hit a regular temp file). Exact targeting via `--session`, else newest-image-timestamp scanning. Transcript layout is Claude Code internals; treat as best-effort.
- **Single responsibility**: visual parsing only. Web search and page fetching live in `modsearch`.

```bash
pnpm install
```

## Code Organization

```
src/
├── main.ts           # CLI entry: analyze (default), recover-paste, config subcommands
├── analyzer.ts       # orchestration: input resolution, config merge, provider dispatch
├── config.ts         # layered config load/set/show/init
├── prompt.ts         # vision prompt (local/remote agent modes + inline api mode)
├── schema.ts         # vision result JSON schema (single source of truth)
├── imageInput.ts     # base64/mime helpers + tolerant JSON extraction
├── recoverPaste.ts   # Claude Code transcript image recovery
└── providers/
    ├── index.ts        # provider interface + registry (5 providers + aliases)
    ├── antigravity.ts  # agy subprocess provider
    ├── claudeCli.ts    # claude subprocess provider (Read-only tools)
    ├── geminiApi.ts    # Gemini Developer API
    ├── openaiCompat.ts # any OpenAI-compatible multimodal endpoint
    └── anthropicApi.ts # Claude API (forced tool call)
```

Tests are co-located: every module has an adjacent `*.test.ts` (vitest). The CLI is exposed via `dist/main.js` (vite lib build; Node built-ins auto-externalized).

## Skills Directory

```
skills/modlens/
├── SKILL.md                    # triggering + per-harness path finding + workflow
└── references/
    ├── output-schema.md        # output contract
    └── configure.md            # per-provider setup recipes the agent can execute
```

## CLI Usage

```bash
modlens -i screenshot.png                     # default provider (antigravity-cli)
modlens -i screenshot.png -p gemini-api       # fastest free route (5-10s)
modlens recover-paste --session <uuid>        # Claude Code pasted-image recovery
modlens config show
```

## Verification

- `pnpm typecheck && pnpm test` for unit-level checks; `pnpm build` must produce a single `dist/main.js`.
- Real end-to-end runs consume the user's provider quota (agy, API keys, Claude subscription). Ask before running them in bulk.

## Operational Docs (`docs/`)

1. Operational docs use front-matter metadata (`summary`, `read_when`).
2. Before creating a new doc, run `pnpm docs:list` to review the existing index.
3. Existing docs: `commit`, `testing`, `research-gemini-claude-skills` (historical, Gemini CLI era).

## .gitignore must include

- `node_modules/`
- `dist/`
- `skills/**/outputs/`
- common logs/cache/system files
