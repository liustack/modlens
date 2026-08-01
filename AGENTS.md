# Project Overview (for AI Agent)

## Goal

Provide the `modlens` CLI tool that converts image sources (local path or remote URL) into structured text evidence for non-vision LLM workflows.

## Technical Approach

- **Pluggable vision provider** — v2 ships with Antigravity CLI (`agy`) as the default provider. The provider interface (`buildInvocation` + `parseOutput`) keeps the next engine swap contained to one file.
- **Schema-enforced JSON output**: the provider is invoked with `--json-schema`, so the structured result comes back guaranteed, no markdown scraping.
- **Single responsibility**: this project only handles visual parsing. Web search and page fetching live in `modsearch`.

```bash
pnpm install
```

## Code Organization

```
src/
├── main.ts       # CLI entry
├── analyzer.ts   # orchestration: input resolution, provider run, envelope
├── prompt.ts     # vision extraction prompt
├── schema.ts     # JSON schema enforced on the provider
└── providers/
    ├── index.ts        # provider interface + registry
    └── antigravity.ts  # agy invocation + output parsing
```

## Skills Directory

```
skills/
└── modlens/
    ├── SKILL.md
    └── references/
        └── output-schema.md
```

The CLI is exposed via `dist/main.js`.

## CLI Usage

```bash
modlens -i screenshot.png
modlens -i screenshot.png -o lens.json -m gemini-3.1-pro-high --prompt "focus on the table"
```

The default provider requires Antigravity CLI installed and signed in (`agy`). Runs take 15-40 seconds.

## Verification

- `pnpm typecheck && pnpm test` for unit-level checks (invocation building, output parsing).
- Real end-to-end runs consume the user's agy quota. Ask before running them in bulk.

## Operational Docs (`docs/`)

1. Operational docs use front-matter metadata (`summary`, `read_when`).
2. Before creating a new doc, run `pnpm docs:list` to review the existing index.
3. Before coding, check the `read_when` hints and read relevant docs as needed.
4. Existing docs: `commit`, `testing`, `research-gemini-claude-skills` (historical, Gemini CLI era).

## .gitignore must include

- `node_modules/`
- `dist/`
- `skills/**/outputs/`
- common logs/cache/system files
