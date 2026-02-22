---
summary: 'Research Notes: Gemini CLI invocation mechanics + Claude Code skills model'
read_when:
  - Designing or updating ModLens runtime behavior
  - Updating skill metadata/trigger strategy
  - Verifying compatibility with Claude Code and Gemini CLI
---

# Research Notes: Gemini CLI + Claude Code Skills

Date: 2026-02-22

## 1) Gemini CLI Findings (v1 implementation impact)

- Local environment verified: `gemini --version` is `0.24.0`.
- CLI help shows `-p/--prompt` is deprecated but still supported; positional prompt is the recommended long-term mode.
- `--output-format` supports `text | json | stream-json`; `json` is suitable for machine parsing.
- Gemini CLI supports `@path` references in prompt. For file references, docs specify that `@` can force full content inclusion.
- Package source inspection confirms images are handled as `inlineData` (base64 + MIME) when explicitly referenced by `@path` and passed through `read_many_files`.

Implementation decision:
- v1 keeps `gemini -p` (matching current project requirement) + `--output-format json`.
- To avoid workspace-bound path misses, include `--include-directories <image-dir>`.

## 2) Claude Code Skills Findings

- Official docs define skills as foldered instruction packs with frontmatter metadata.
- Triggering relies heavily on `name` and `description` in frontmatter.
- Supported frontmatter controls include `allowed-tools`, `disable-model-invocation`, `model`, and `context` behaviors.
- Skills can be project-level and chained by the agent when descriptions match user intent.

Implementation decision:
- `skills/modlens/SKILL.md` uses explicit trigger description for image tasks + non-vision model scenarios.
- `allowed-tools: Bash` is set so the agent can deterministically call `modlens`.
- Scope is intentionally limited to image parsing; no modsearch/modfetch logic is included.

## 3) Primary Sources

- Gemini CLI repo README: https://github.com/google-gemini/gemini-cli
- Gemini CLI file management docs (`@` references): https://gemini-cli.xyz/docs/cli/file-management/
- Claude Code skills docs: https://docs.claude.com/en/docs/claude-code/agent-skills
- Anthropic skills examples repo: https://github.com/anthropics/skills
- Claude help center (skills overview): https://support.claude.com/en/articles/11817219-what-are-skills
