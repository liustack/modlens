# ModLens

A CLI toolkit for AI agents that converts image sources (local path or remote URL) into structured text evidence, bridging the vision gap for text-only LLM workflows.

[中文说明](README.zh-CN.md)

## Features

- Built for non-vision LLM setups (text-only models + external vision bridge)
- Supports local image paths and remote image URLs
- Pluggable vision backend — ships with Gemini CLI; more engines (PaddleOCR, DeepSeek, etc.) planned
- Outputs machine-consumable JSON (OCR + layout + semantics + visual clues)
- Designed to be called from Agent Skills (Claude Code, Codex, Cursor, etc.)

## Install

```bash
npm install -g @liustack/modlens
```

The default backend requires Gemini CLI to be installed and authenticated:

```bash
npm install -g @google/gemini-cli
gemini
```

Or run with `npx`:

```bash
npx @liustack/modlens [options]
```

## Usage

```bash
# Print JSON result to stdout
modlens -i screenshot.png

# Save to file
modlens -i screenshot.png -o lens.json

# Specify model + extra prompt constraints
modlens -i screenshot.png -m gemini-2.5-flash --prompt "Focus on table structure"
```

## Options

| Flag | Description |
|------|-------------|
| `-i, --input <path>` | Input image path (required) |
| `-o, --output <path>` | Write result JSON to a file |
| `-m, --model <name>` | Vision model name (backend-specific) |
| `--prompt <text>` | Extra extraction constraints |
| `--timeout <ms>` | Timeout in milliseconds (default: `180000`) |
| `--gemini-bin <path>` | Gemini CLI binary path (default: `gemini`) |

## Vision Backends

ModLens uses a pluggable architecture for vision recognition. The current v1 ships with **Gemini CLI** as the default backend. Future versions will support additional engines such as PaddleOCR, DeepSeek OCR, and other multimodal/vision-capable models.

## Agent Skill

- [modlens/SKILL.md](skills/modlens/SKILL.md)

## Notes

- `modlens` focuses on visual parsing only.
- `modsearch` and `modfetch` belong to separate projects and are intentionally out of scope.

## Disclaimer

This project is for **personal learning and experimentation only**. It is not intended for commercial use.

## License

MIT
