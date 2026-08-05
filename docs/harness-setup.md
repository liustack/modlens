---
summary: 'Harness setup: how images reach the model in Codex, Claude Code, Pi, and OpenCode'
read_when:
  - Setting modlens up inside a specific coding agent
  - A pasted image is not reaching the model
  - Understanding what recover-paste does per harness
---

# Harness setup

Where a pasted image ends up differs per harness, and modlens takes a different route in each. `recover-paste` detects which harness it runs inside (process ancestry, then environment fingerprints) and reads only that harness's storage.

## Codex

Pasted images become real temp files, and the message carries a tag like `<image name=[Image #1] path="/tmp/xxxx.png">`. The skill reads the path out of the tag. `recover-paste` detects Codex and refuses, pointing back at the tag.

One catch with text-only models: once `models.json` declares `input_modalities: ["text"]`, the Codex TUI blocks Ctrl+V paste outright. Drag the file into the terminal, type its path, or use `codex exec -i image.png "..."`.

## Claude Code, Pi, OpenCode

None of them writes a pasted image to a regular temp file, but all three persist the user message locally before any gateway strips it:

| Harness | Storage | Notes |
| :-- | :-- | :-- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | images as base64. The injected `CLAUDE_CODE_SESSION_ID` targets the exact session |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | same shape as Claude Code |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite, images as data URLs. Needs Node 22.5+ for `node:sqlite` |

Running a text-only model behind `ANTHROPIC_BASE_URL` in Claude Code, a pasted image arrives as a pathless `[Unsupported Image]` placeholder (on lenient gateways) or breaks the request outright ([#62009](https://github.com/anthropics/claude-code/issues/62009)). The bytes are not gone, and that is what `recover-paste` retrieves.

## Skill locations

| Harness | Reads skills from |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi, OpenCode | `~/.agents/skills/` |

Symlinks work in all of them, so linking the skill folder once keeps every agent on the latest version.

## Gateway setups

OpenCode with DeepSeek: `opencode auth login`, pick DeepSeek and paste the key (it lands in `~/.local/share/opencode/auth.json`), then set the default model in `~/.config/opencode/opencode.jsonc` to `deepseek/deepseek-v4-flash`. Pi reads its key from `~/.pi/agent/auth.json`.
