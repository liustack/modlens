# Changelog

## Unreleased

A code-review pass. Two user-facing bugs, a stack of doc corrections, and the tooling a public repo is expected to carry.

- `config show` prints the effective config now, merging environment variables over the file and tagging each value file or env. Reading only the file hid keys set through `GEMINI_API_KEY` and the other bound vars, so the value modlens actually used never appeared.
- Local image paths containing `#` or `?` keep their real extension. Routing them through `new URL()` read the character as a fragment or query and dropped the extension, mislabelling the type as JPEG.
- The disclaimer no longer contradicts the MIT license it ships beside. It withholds warranty and endorsement without withholding the commercial-use right MIT grants, and points at the upstream engines' own terms.
- Docs caught up with the code. Both READMEs gained `--provider-bin`, `--workdir`, a per-provider default-model table, a full `recover-paste` flag table, and the `meta` output fields, with `MODLENS_HARNESS` and `--out-dir` written up in troubleshooting. The anthropic recipe warns that `ANTHROPIC_BASE_URL` can silently reroute a vision request to a text-only gateway. AGENTS.md drops three claims that had gone stale.
- Internals, all behavior-preserving: the duplicated JSON helpers (parse, extract, truncate) collapsed into one `util/json` module, and the 710-line `recoverPaste` split into per-harness modules. An always-true branch and a few lint findings cleared.
- Tooling: Biome for formatting and linting on the repo's 4-space style, a Node 18/20/22 CI matrix that skips the `node:sqlite` tests where the module is unavailable, `@vitest/coverage-v8` with a `coverage` script, tests for the CLI assembly, and a tag-triggered release workflow that publishes with provenance. Adds the collaboration files a public repo expects: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and pull-request templates, and Dependabot.
- The Chinese README's plug now invites readers to the WeChat public account rather than installing the liustack skills.
- `release.mjs` matches the CHANGELOG again: version dots are escaped literally and the section ends at end of file, so the newest entry (and versions like `2.8.0`) match instead of being missed.

## 2.8.0 - 2026-08-06

- README rebuilt against how widely used projects actually write theirs: install command inside the first screen, a nav row and badges in the hero, short scannable highlights, and roughly 1,000 words instead of a long read. Harness specifics and security detail moved into `docs/harness-setup.md` and `docs/security.md`, with a Documentation table pointing at them.

## 2.7.11 - 2026-08-06

- Stops calling it OCR. A vision model reading an image is not OCR, which is a specific and different technology, and the word was borrowed for convenience across the README, the skill, and both articles. The prose now says what actually happens: every word in the image is transcribed. The `ocr` field in the output contract keeps its familiar name, with a note that a vision model does the reading.

## 2.7.10 - 2026-08-06

- README rewritten rather than patched again. The hero buried the one thing that sets this apart (you can paste) under a generic pitch, then repeated it in a feature list and again in its own section. The opening now leads with pasting, the feature list is gone as duplication, and the comparison against swapping models or running a vision MCP server sits where a reader weighing options will find it.

## 2.7.9 - 2026-08-06

- The flow diagram says something again. Replacing ASCII art with an abstract illustration removed the labels along with the alignment chore, which was a bad trade. It is now a rendered diagram with real labels, one per language, generated from HTML so nothing drifts.

## 2.7.8 - 2026-08-06

- Releases are now one command: `pnpm release <version|patch|minor|major>` refuses a dirty tree, a non-main branch, a duplicate tag, or a version with no CHANGELOG entry, then runs typecheck, tests, and build before anything irreversible happens, and finishes with tag, push, npm publish, and a GitHub release. Publishing by hand is how a version once reached npm with no changelog and no tag behind it.
- Every previously published version now has a git tag, reconstructed from the commit that carried it.

## 2.7.7 - 2026-08-05

- README: leads with a scannable feature block (paste support, evidence rather than a description, honest uncertainty, no model swap, zero-key start, four harnesses) and states requirements. Adds a comparison against swapping in a multimodal model and against vision MCP servers, our own weaknesses included.
- New `docs/troubleshooting.md`: every error this CLI prints, with cause and fix, linked from the README and the skill.
- The ASCII flow diagram is now a real illustration. Its alignment had needed repair across several releases, which is a poor trade for a picture.
- The Gemini CLI era research doc is marked historical so it is not read as current design.

## 2.7.6 - 2026-08-05

- `config init` now writes only the shape (`{"provider": "", "providers": {}}`) instead of all five providers with their fields pre-filled. Baked-in defaults in a config file silently outrank later changes to those defaults, and the placeholders hid the one decision that matters. The command prints what can be set instead.

## 2.7.5 - 2026-08-05

A verification pass on the 2.7.4 fixes (same external reviewer) found four that did not hold and three bugs the fixes themselves introduced. All seven are addressed here.

**Fixes that did not hold**

- Unreadable config files still became empty configs: the 2.7.4 edit never applied, because this file is indented differently from its sibling project. Permissions errors now surface.
- Harness detection still matched a flag's value: `node --require pi app.js` read as Pi. The script behind a node shim must now look like a path to a script.
- agy log evidence was scoped by file mtime alone, so a concurrent call or an older failure in the same file still misdiagnosed this run. Lines are now filtered by their own glog timestamps.
- The openai schema check only looked at top-level keys, so `{"ocr":{}}` passed. Nested required fields are checked.

**Bugs introduced by the 2.7.4 fixes**

- `transcriptBelongsTo` returned on the first recorded cwd, so a transcript whose first line matched could still hand over another project's images. Any matching line now decides, and a transcript with cwd lines that all mismatch is rejected.
- That check also read every transcript in full, then the image scan read it again. Each file is read once.
- The alias table added for config lookups was written by hand and did not match the real provider aliases (`claude` resolves to `anthropic`, not `claude-cli`, and `claude-code` and `openai-compat` were missing), so settings landed on the wrong provider. The table now comes from the provider registry.
- `--transcript` skipped harness validation, so `--harness bogus` silently parsed the file as Claude Code.

## 2.7.4 - 2026-08-05

Correctness and privacy pass after an external review (gpt-5.6-sol) that proved every finding with a probe.

**Recovering the wrong project's images**

- OpenCode directory matching passed the project path straight into SQL `LIKE`, where `_` and `%` are wildcards, so a path containing either matched other projects. Patterns are escaped now.
- `--session <id>` dropped the directory condition entirely, and session slugs are not unique across projects. The reviewer found two colliding slugs in a real local database. A session now narrows the directory match instead of replacing it.
- Claude Code and Pi directory slugs are lossy: `/tmp/project.alpha` and `/tmp/project-alpha` produce the same slug. Both harnesses record the real cwd inside the transcript, which is now checked before a transcript is trusted.

**Privacy**

- Recovered images landed as 0644 inside a 0755 directory, so on a shared `/tmp` any local user could read them. They are written 0600 into a 0700 directory, and re-chmodded because the filenames are content hashes and an existing file keeps its old mode.

**Correctness**

- A successful run could be reported as a timeout: the timer stayed armed while output drained, so a slow drain turned exit code 0 into a timeout error. It is cleared when the child exits.
- A timeout sent one SIGTERM and then waited, so an engine ignoring signals hung the CLI. It now settles immediately and escalates to SIGKILL.
- Output decoding kept no state across chunks, so a multi-byte character split across a chunk boundary became replacement characters.
- The OpenCode "needs Node 22.5" message was swallowed by an empty catch, leaving only "no pasted images". Setup problems now travel with the error.
- `--harness` was ignored when `--transcript` was given, so a copied Pi transcript was parsed as Claude Code. `--transcript <db>` also ignored `--cwd`.
- Harness detection scanned the first eight command tokens, so a command that merely mentioned "pi" in its arguments was detected as Pi. Only the executable, plus the script path behind a node shim, is read now.
- agy log evidence was accepted if the file was under two minutes old, which let a previous quota failure or a concurrent agy call misdiagnose an unrelated error. Evidence must now postdate the start of this run.
- The `claude-cli` provider inherited a 30 second kill grace meant for agy's own `--print-timeout`, silently extending `--timeout`. The grace applies only to engines with an internal deadline.
- The openai provider's "schema validation" accepted `{"summary":"x","ocr":null}` and anything missing layout, semantics, visual, or uncertainty. All required fields are checked.
- Settings saved under a provider alias (`config set gemini.apiKey`) were invisible once the name resolved to `gemini-api`.
- An unmapped image type was relabelled `.png`, so downstream tools reading the extension got the wrong type.
- `ENOENT` from spawn was always reported as a missing CLI, even when the real cause was a missing working directory.
- A config file that exists but cannot be read (permissions) silently became an empty config.

## 2.7.3 - 2026-08-05

- Fix: a failing `antigravity-cli` run now explains itself instead of reporting a bare exit code ([#3](https://github.com/liustack/modlens/issues/3), thanks @mtongle). Providers gained a `describeFailure` hook, and the agy provider uses it to surface agy's own error text and classify the two failures users actually hit: a locked OS keyring in headless sessions (the report's case, where agy claims to be signed out) and an exhausted weekly quota. Both messages end with the exact commands to switch to a keyless, quota-independent provider. Diagnosis only reads agy's log when this run produced an agy error envelope and the log is fresh, so stale logs cannot misdiagnose an unrelated failure.
- Docs: README leads with paste support, recommends the free AI Studio key over the slower agy default, and documents that the skill configures modlens for you on request.

## 2.7.2 - 2026-08-05

- Fix: runs with the `antigravity-cli` provider hung until the timeout killed them ([#1](https://github.com/liustack/modlens/issues/1), thanks @hawkmor for the diagnosis). agy exits cleanly but leaves a language server holding the inherited stdout pipe, so the child's `close` event never fires. The provider run now settles on `exit` plus a short drain window, and releases the pipes afterwards so a lingering descendant cannot keep the CLI process alive either.

## 2.7.1 - 2026-08-04

- Docs: per-harness skill discovery paths (`~/.claude/skills/`, `~/.codex/skills/`, `~/.agents/skills/` for Pi and OpenCode), OpenCode + DeepSeek setup recipe, and the four-harness live verification matrix (Claude Code session-id recovery, OpenCode full skill loop on DeepSeek, Pi store isolation, Codex refusal).

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
