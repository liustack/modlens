# Changelog

## 2.4.3 - 2026-08-03

- Docs: the Claude Code paste-recovery loop is now marked as verified end to end in a real DeepSeek-gateway session (placeholder spotted, file recovered by session id, image answered in full).

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
