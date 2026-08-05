# Project Overview (for AI Agent)

## Goal

Provide the `modlens` CLI tool that converts image sources (local path or remote URL) into structured text evidence for non-vision LLM workflows.

## Technical Approach

- **Five vision providers behind one interface** (`src/providers/index.ts`). Subprocess providers implement `buildInvocation` + `parseOutput` (antigravity-cli, claude-cli); in-process API providers implement `execute` (gemini-api, openai, anthropic). `antigravity-cli` is the zero-config default.
- **Schema-enforced JSON output** wherever the backend allows: `--json-schema` on the two CLIs, `responseJsonSchema` on gemini-api, a forced tool call on anthropic. The openai route uses a template-instance prompt (weak gateways echo raw schemas back) plus shape validation that fails loudly.
- **Layered config**: CLI flags > env vars (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`) > `~/.modlens/config.json` (managed by `modlens config init/set/show`, 0600, masked rendering) > built-ins.
- **Paste recovery across harnesses**: `modlens recover-paste` pulls pasted image bytes out of local session storage (pastes never hit a regular temp file). It supports Claude Code and Pi (JSONL transcripts) and OpenCode (SQLite, needs Node 22.5+), detects Codex and defers to its on-disk temp files, and scopes to the harness it runs inside via process ancestry. Exact targeting via `--session`, else newest-image-timestamp scanning. Storage layouts are each harness's internals, so treat this as best-effort.
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
├── imageInput.ts     # base64/mime helpers (local + remote image bytes)
├── util/json.ts      # shared JSON helpers (parse, extract, truncate)
├── recoverPaste/     # paste recovery: adapters/{claude,pi,opencode}, detect, jsonl, index
└── providers/
    ├── index.ts        # provider interface + registry (5 providers + aliases)
    ├── antigravity.ts  # agy subprocess provider
    ├── claudeCli.ts    # claude subprocess provider (Read-only tools)
    ├── geminiApi.ts    # Gemini Developer API
    ├── openaiCompat.ts # any OpenAI-compatible multimodal endpoint
    └── anthropicApi.ts # Claude API (forced tool call)
```

Tests are co-located: modules get an adjacent `*.test.ts` (vitest), the CLI assembly in `main.ts` included. A few pure-data modules such as `schema.ts` carry none, since there is no behavior to pin. The CLI is exposed via `dist/main.js` (vite lib build, Node built-ins auto-externalized).

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
3. Existing docs: `troubleshooting` (every error this CLI prints, with causes and fixes), `harness-setup` (how a pasted image reaches the model in each harness), `security` (recovered-image privacy, permissions passed to engines, untrusted image content), `testing`, `commit`, `research-gemini-claude-skills` (historical, Gemini CLI era).

## .gitignore must include

- `node_modules/`
- `dist/`
- `skills/**/outputs/`
- common logs/cache/system files
