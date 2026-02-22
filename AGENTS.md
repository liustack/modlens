# Project Overview (for AI Agent)

## Goal

Provide the `modlens` CLI tool that converts image sources (local path or remote URL) into structured text evidence for non-vision LLM workflows.

## Technical Approach

- **Pluggable vision backend** — v1 ships with Gemini CLI; future versions will support additional engines (PaddleOCR, DeepSeek OCR, other multimodal models)
- **JSON output**: image content → OCR text, semantic meaning, structure, and layout
- **Single responsibility**: this project only handles visual parsing (no web search / fetch)

```bash
pnpm install
```

## Code Organization

```
src/
├── main.ts       # CLI entry
├── analyzer.ts   # Vision backend invocation + parsing
└── prompt.ts     # Vision extraction prompt
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
modlens -i screenshot.png -o lens.json --model gemini-2.5-flash
```

## Operational Docs (`docs/`)

1. Operational docs use front-matter metadata (`summary`, `read_when`).
2. Before creating a new doc, run `pnpm docs:list` to review the existing index.
3. Before coding, check the `read_when` hints and read relevant docs as needed.
4. Existing docs: `commit`, `testing`, `research-gemini-claude-skills`.

## .gitignore must include

- `node_modules/`
- `dist/`
- `skills/**/outputs/`
- common logs/cache/system files
