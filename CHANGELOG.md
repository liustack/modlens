# Changelog

## 2.7.0 - 2026-08-04

- `recover-paste` now identifies the harness it is running inside before touching any storage: process ancestry first (the nearest known harness among parent processes, which also resolves nested setups to the innermost tool), env fingerprints second (`CLAUDECODE`, `PI_CODING_AGENT`, `CODEX_THREAD_ID`). Detection scopes recovery to that harness's store only, so another tool's stale sessions can never hijack a paste; Codex is refused outright with path-tag guidance. `--harness <name|none>` overrides, output gains a `detected` field.
- In Claude Code, recovery auto-targets the exact session from the injected `CLAUDE_CODE_SESSION_ID`, falling back to newest-image scanning when that transcript holds no images (subagent sessions).

## 2.6.1 - 2026-08-03

- Fix: opencode runs shell commands at the repo root while sessions record the directory they were launched in. Exact directory matching made recovery miss the real paste and fall through to stale Claude Code transcripts of the same project, recovering the wrong images (caught in a live session). Directories now match by prefix in both directions, and recovery is scoped to the single opencode session owning the newest image.
- Recovered entries report `filename` (the original attachment name) when the harness stored one.
- Skill: recovered paths are oldest to newest so analyze the last one first, match `filename` when present, run every command yourself instead of delegating to the user, and treat a `harness` value that differs from the harness you are running in as suspect.

## 2.6.0 - 2026-08-03

- `recover-paste` now supports OpenCode: pasted/attached images are read from its SQLite store (`~/.local/share/opencode/opencode.db`) via node:sqlite (Node 22.5+, lazy-loaded so older Nodes keep the JSONL harnesses). Recovery internals refactored into per-harness adapters (Claude Code, Pi, OpenCode) sharing one newest-image picker. Verified against a real opencode + deepseek session.

## 2.5.0 - 2026-08-03

- `recover-paste` now supports Pi (Armin Ronacher's coding agent) alongside Claude Code: both store pasted images as base64 in per-session JSONL files, and recovery auto-detects which harness owns the newest pasted image. Verified live against a real pi + deepseek session. Result JSON gains a `harness` field.

## 2.4.3 - 2026-08-03

- Docs: the Claude Code paste-recovery loop is now marked as verified end to end in a real DeepSeek-gateway session (placeholder spotted, file recovered by session id, image answered in full).

## 2.4.2 - 2026-08-03

- Project hygiene: CHANGELOG, GitHub Actions CI, AGENTS.md rewrite, testing guide rewrite, recover-paste and config command reference in READMEs, dead code removal, auto-externalized Node built-ins in the build.

## 2.4.1 - 2026-08-03

- Skill: path-finding is now a per-harness decision tree. Codex path tags never trigger transcript recovery, unknown harnesses are told to ask for a path instead of guessing.

## 2.4.0 - 2026-08-03

- `recover-paste --session <id>`: exact transcript targeting. Skills relay `${CLAUDE_SESSION_ID}` (substituted by Claude Code since v2.1.9); without it, recovery falls back to newest-image-timestamp scanning.

## 2.3.2 - 2026-08-03

- Tests co-located with sources, one module one `.test.ts` (31 to 50 tests). First direct coverage for `prompt` and `imageInput`.
- Skill explains why `recover-paste` takes no session id.

## 2.3.1 - 2026-08-03

- `recover-paste` locates the session by newest pasted-image timestamp instead of file mtime, immune to concurrent sessions in the same project.

## 2.3.0 - 2026-08-03

- New `recover-paste` command: recovers images pasted into Claude Code from the local session transcript (they never hit a regular temp file), prints real file paths as JSON.

## 2.2.0 - 2026-08-03

- New `claude-cli` provider: rides an existing Claude Code login, `--allowedTools Read` only, `--json-schema` enforced, haiku default.
- Skill routes configuration questions to `references/configure.md`.

## 2.1.0 - 2026-08-02

- Three direct-API providers: `gemini-api` (free AI Studio key, `responseJsonSchema`), `openai` (any OpenAI-compatible multimodal endpoint), `anthropic` (forced tool call, Claude Haiku default). 3-10s per image versus 15-40s agent loops.
- Layered config: `~/.modlens/config.json` via `config init/set/show` (0600, masked), env vars override the file, flags override everything.

## 2.0.0 - 2026-08-01

- Breaking: vision engine migrated from the discontinued Gemini CLI free tier to Antigravity CLI (`agy`).
- Provider layer (`buildInvocation` + `parseOutput`), schema-enforced structured output via `--json-schema`, no markdown scraping.
- Output contract v2: `result`/`meta` envelope; fabricated bbox and confidence fields dropped.
