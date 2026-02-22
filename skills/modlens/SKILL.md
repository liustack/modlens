---
name: modlens
description: "Bridge image understanding for non-vision LLM workflows. Use when user provides screenshots/photos/charts/doc images and the active model lacks multimodal vision. Call modlens to extract OCR text, semantics, structure, and layout as JSON evidence."
allowed-tools:
  - Bash
---

# ModLens — Vision Bridge Skill

Use this skill when:
- User asks to analyze an image/screenshot/chart/document photo
- Current model cannot directly read images
- You need structured visual evidence before downstream reasoning

Do not use this skill for:
- Web search (`modsearch`)
- Web fetch (`modfetch`)

## Prerequisites

```bash
modlens --version
```

The default vision backend (Gemini CLI) must also be installed and authenticated:

```bash
gemini --version
```

If `gemini` is missing:

```bash
npm install -g @google/gemini-cli
gemini
```

## Command

```bash
modlens -i <image-path>
```

Optional:

```bash
modlens -i <image-path> -o <output-json-path> -m <model-name> --prompt "<extra constraints>"
```

## Workflow

1. If user includes one or more images, run `modlens` for each image.
2. Parse returned JSON.
3. Feed `summary`, `ocr`, `layout`, and `semantics` back into your reasoning context.
4. If confidence is low or uncertainty is high, tell user what is ambiguous.

## Output Contract

- `summary`: high-level description
- `ocr.full_text` + `ocr.lines`: extracted text evidence
- `layout.regions`: structural/layout blocks with reading order
- `semantics`: entities, scene, intent, relations
- `visual`: color/style clues
- `uncertainty`: uncertain points

Detailed schema: `references/output-schema.md`

## Failure Handling

- If command fails due to missing auth or quota, report exact error and ask user to check backend setup (e.g., run `gemini` for Gemini CLI login).
- If JSON is partially malformed, keep raw text and continue with best-effort extraction.

## Implementation Note

v1 uses Gemini CLI as the default vision backend (`gemini -p` with JSON output mode). The architecture is designed to support additional vision engines (PaddleOCR, DeepSeek OCR, etc.) in future versions.
