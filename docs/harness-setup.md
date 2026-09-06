---
summary: 'Harness setup: how images reach the model in Codex, Claude Code, Pi, and OpenCode'
read_when:
  - Setting modlens up inside a specific coding agent
  - A pasted image is not reaching the model
  - Understanding what recover-paste does per harness
---

# Harness setup

English | [中文](harness-setup.zh-CN.md)

Where a pasted image ends up differs per harness, and modlens takes a different route in each. `recover-paste` detects which harness it runs inside (process ancestry, then environment fingerprints) and reads only that harness's storage.

## Codex

Pasted images become real temp files, and the message carries a tag like `<image name=[Image #1] path="/tmp/xxxx.png">`. The skill reads the path out of the tag. `recover-paste` detects Codex and refuses, pointing back at the tag.

One catch with text-only models: once `models.json` declares `input_modalities: ["text"]`, the Codex TUI blocks Ctrl+V paste outright. Drag the file into the terminal, type its path, or use `codex exec -i image.png "..."`.

## Claude Code, Pi, OpenCode

None of them hands the model a usable temp-file path the way Codex does (newer Claude Code builds do write pastes to their own `~/.claude/image-cache/`, injected as a path line only in the terminal entrypoint), but all three persist the user message locally before any gateway strips it:

| Harness | Storage | Notes |
| :-- | :-- | :-- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | images as base64. The injected `CLAUDE_CODE_SESSION_ID` targets the exact session |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | same shape as Claude Code |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite, images as data URLs (read via `node:sqlite`) |

Running a text-only model behind `ANTHROPIC_BASE_URL` in Claude Code, a pasted image arrives as a pathless `[Unsupported Image]` placeholder (on lenient gateways) or breaks the request outright ([#62009](https://github.com/anthropics/claude-code/issues/62009)). The bytes are not gone, and that is what `recover-paste` retrieves.

## Skill locations

| Harness | Reads skills from |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi, OpenCode | `~/.agents/skills/` |

Symlinks work in all of them, so linking the skill folder once keeps every agent on the latest version.

## Platform support

macOS and Linux are fully supported and verified in CI on Node 22 and 24.

Windows runs the same CI matrix. Detection there skips the process-ancestry pass, since there is no `ps`, and falls back to the environment fingerprints above, so a harness that sets none of them reads as undetected (force it with `--harness` or `MODLENS_HARNESS`). OpenCode paste recovery is covered on Windows, including the path-separator normalization from [#11](https://github.com/liustack/modlens/issues/11): opencode records `session.directory` with forward slashes while `path.resolve` returns backslashes there, and both sides are normalized before matching. The JSONL stores (Claude Code, Pi) key off `os.homedir()` and each harness's own on-disk slug, and are exercised on POSIX. External engines (Antigravity CLI, the Claude CLI) run only where they ship a Windows build.

## Gateway setups

OpenCode with DeepSeek: `opencode auth login`, pick DeepSeek and paste the key (it lands in `~/.local/share/opencode/auth.json`), then set the default model in `~/.config/opencode/opencode.jsonc` to `deepseek/deepseek-v4-flash`. Pi reads its key from `~/.pi/agent/auth.json`.

## DeepSeek Harness (dsh)

dsh is different from the other harnesses: modlens plugs in as a native tool, not a prompt-triggered skill. The package itself is a dsh bundle, so one command installs it into a profile:

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modlens@3.25.4
```

This registers a `modlens_read_image` tool whose schema reaches the model on every request (no trigger heuristics), runs the modlens CLI shipped inside the same package, and returns the structured evidence as the tool's canonical JSON output. Engines, reuse grants, and guard rules stay in `~/.modlens/config.json`, shared with every other harness. dsh is in developer preview and its plugin surface may change; the plugin keeps its touch small (raw tool registration, the llm adapter surface for the vision variants, the attachment reader, and one agent pre-step hook) and degrades loudly if any of them moves.

### Configuring the engine from the web UI

dsh web users have no terminal in front of them, so the engine settings have a
card in **Settings → Plugins → Plugin configuration**: which engine reads
images, its key, endpoint, model and proxy route, and which local sign-ins a read may
borrow. Expanding it probes this machine and lists the harnesses it actually
found, so the grants are a choice between real options rather than five names.

The values live where they always did, in `~/.modlens/config.json`, shared
with every other harness: the card reads and writes that file through a
loopback route, so an edit here is the same edit `modlens config set` makes.
The card never receives a stored key or proxy URL, only whether the key is set
and whether proxy routing inherits, connects directly, or uses a custom URL.
Leaving either secret field empty keeps the stored value. `settingsCard: false`
in the plugin row removes it, route included.

The card's own text follows dsh's interface language setting, switching
between Chinese and English as you switch dsh. On a dsh too old to expose that
setting to plugins, it follows the browser language instead. What the server
says back on a failure (an unknown engine, a path that would not open) stays as
it is: that is the diagnosis, not copy.

### Keeping it up to date

modlens ships often, and both install shapes freeze at whatever version they
got. On dsh, re-run the install with the version named:

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> add @liustack/modlens@3.25.4
```

`npm view @liustack/modlens version` prints the current one, and this page is
stamped with it at release time.

Two things in that command are deliberate. `add`, not `update`, because
`update` stays inside the semver range already recorded, and a plain install
records a caret range, so a profile that once landed on 2.7.1 updates to 2.8.0
and never crosses into 3.x. And a named version rather than `@latest`, because
pnpm 11 holds back anything published in the last 24 hours
(`minimumReleaseAge`, on by default) and resolves the tag against what survives
that filter: `@latest` lands on an older release instead of skipping the gate.
What it costs is a day of wall-clock time rather than one version, which on a
fast-moving week is several releases. A named version is a deliberate request,
so pnpm installs it, and since 11.1.3 records that one version as an approved
exception in the profile's `pnpm-workspace.yaml`, leaving everything else
behind the window.

Restart dsh, then confirm what actually landed:

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> list
```

The [troubleshooting page](troubleshooting.md#dsh-says-declares-no-dshbundle--installed-as-a-plain-dependency)
covers the stricter case, where you configured `minimumReleaseAge` yourself and
pnpm refuses rather than approves.

On the skill harnesses a skill is a copied folder, and the copy keeps its
install-time version, so re-run the install to overwrite it in place.
`modlens doctor` reads the pin out of every copy it can find and flags the ones
behind the CLI doing the reporting, which makes the drift visible before it
costs anyone a debugging session.

### A session that already holds an image

dsh refuses to switch a session that contains image attachments to a model
whose declared modalities exclude images, which includes every plain text-only
DeepSeek entry. The rule is dsh's and it is sound: a text-only model cannot
receive a history carrying image blocks, and the `(modlens vision)` variant is
switchable there not because it declares image input but because it converts
those blocks to evidence text at request time, which the plain entry does not
do ([#40](https://github.com/liustack/modlens/issues/40)).

Pasting through the first route above avoids the situation entirely: the image
becomes a file path and the session never holds an attachment, so nothing locks
the model selector. It only comes up after a paste on a variant or on a vision
model, where an attachment is the point.

### For other plugin authors: injecting images on a `(modlens vision)` route

A wrapper route's declared `inputModalities: ['text', 'image']` is a promise,
not decoration ([#74](https://github.com/liustack/modlens/issues/74)). Every
`image` block in the request — pasted by the user or injected by another
plugin, including blocks nested in tool results — is converted to structured
evidence text at request time, before the wire reaches the text-only upstream.
Nothing is silently dropped, so the branch "declared image → inject a native
image block, otherwise inject a file path" works unchanged whether the
declaring route is a real vision model or a modlens wrapper.

One requirement: the block must carry a host attachment reference, the shape
`ctx.attachments.saveImage` returns and a Web UI paste produces — the plugin
reads bytes through `ctx.attachments.readImage(block.attachment)`. A
hand-built block holding only a path or base64 payload degrades to a constant
read-failure placeholder. And do not add a file-path text next to an image
block on an image-declaring route: the block already becomes complete
evidence there, and the extra path invites a second read of the same image
through the tool — double quota, and a second wording of the same content,
which is exactly the prefix-cache churn
[#68](https://github.com/liustack/modlens/issues/68) removed.

### Paste-to-path (web profile)

Pasting an image into the dsh Web UI under a **text-only model** used to die at
image admission. The plugin now ships a browser half (loaded automatically by
dsh's client plugin system) that takes over the paste in exactly that case:
the image bytes go to the plugin's `/modlens/paste` route on the dsh web
server (loopback, magic-byte checked, 25 MB cap), land as a private temp file,
and the composer receives the file path as plain text — the same shape Pi,
OpenCode, and Claude Code hand their models, and the modlens skill's and
`modlens_read_image` tool's primary trigger. Admission never fires because the message
carries no image attachment.

The takeover is conditional, and the decision is the host's: the browser half
asks the plugin's route whether the currently selected model is text-only,
and the host answers from the provider registry's declared model metadata
(`inputModalities`), not from a name heuristic. A `(modlens vision)` variant
or any model that declares image input keeps its native paste flow (variants
convert at request time with the thumbnail preserved; vision models read
images themselves), and so does any model the host cannot resolve. Pastes
stay native until the host has confirmed a takeover is right. A model whose
metadata declares no input modalities counts as unresolved: absent metadata is
never read as "confirmed text-only". Verdicts also age out (60s), so a route
whose models changed mid-session is re-asked, not trusted forever.
`pasteToPath: false` in the plugin row turns the whole feature off: the
browser half stands down when the policy endpoint 404s. If the route vanishes
mid-session after a verdict already confirmed it, the pastes made in the
brief window before the failed upload comes back (one local round-trip) are
lost. The client then forgets its verdicts and every later paste goes
native.
