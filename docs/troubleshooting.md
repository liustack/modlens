---
summary: 'Troubleshooting: every error modlens can print, what causes it, what to do'
read_when:
  - A run failed and the message is not self-explanatory
  - recover-paste found nothing, or found the wrong image
  - Deciding whether a failure is setup, quota, or a bug
---

# Troubleshooting

English | [中文](troubleshooting.zh-CN.md)

Start with `modlens doctor`: it checks your Node version, which providers are ready (including how many API keys each one has), which one will be selected and why, the cooldown switch and any cooling keys, and the detected harness, all without spending quota or making a network request. It catches most setup problems before you read any further. A spent key rotates to the next one, then cools, so the next run tries a healthy key first.

Every message below is one modlens actually prints. Search this file for the words you saw.

## Antigravity CLI cannot read its stored login token

```
Antigravity CLI cannot read its stored login token.

On Linux this usually means the OS keyring is locked, which is normal for headless
sessions (agents, cron, systemd, SSH without a desktop login) ...
```

agy keeps its token in the OS keyring. When the keyring is locked, agy reports itself as signed out and tries a browser sign-in that cannot finish without a display. Three ways forward:

- Unlock the keyring, or run modlens from a desktop session.
- Sign in again with `agy`.
- Switch to a provider that needs no interactive login:

```bash
modlens config set gemini-api.apiKey <key>   # free key: https://aistudio.google.com
modlens config set provider gemini-api
```

## Quota exhausted

```
Individual quota reached. ... Resets in 94h19m9s.

agy's free tier is one weekly bucket shared by the desktop app, the CLI, and the SDK ...
```

Wait for the reset, or move to `gemini-api`, which has its own budget. Parallel subagents drain the shared bucket fast, so a heavy day can end it.

## Provider CLI not found

```
Provider CLI not found: agy (spawn ENOENT). Install it and sign in first.
```

The binary is not on PATH, or `--provider-bin` points somewhere wrong. A different spawn-level failure (`... could not start \`claude\`: spawn EACCES`) keeps its real error code so the cause is nameable. On Windows the npm-installed CLIs are `.cmd` shims; modlens resolves them through PATHEXT and runs their real Node entry directly, so neither the bare name (ENOENT) nor the `.cmd` (EINVAL) trips it up.

```
Working directory does not exist: /some/path
```

Different cause, same underlying error code from the OS: `--workdir` points at a directory that is not there. The binary is fine.

## recover-paste found nothing

```
No pasted images found in any session storage for this directory (looked in: ...)
```

In order of likelihood:

- **You are in the wrong directory.** Recovery is scoped to the project the conversation is happening in. Pass `--cwd /path/to/project`.
- **Nothing was pasted.** Dragged files and typed paths are already real files, so there is nothing to recover: use the path directly.
- **A setup problem is blocking one harness.** Anything blocking appears after `Blocked:` in the same message, for example OpenCode needing Node 22.13+ for `node:sqlite`.

## recover-paste returned an image from another project

This should not happen any more, and if it does it is a bug worth reporting. Recovery checks the working directory recorded inside the transcript, not just the directory name, because directory slugs collide (`/tmp/a.b` and `/tmp/a-b` produce the same one). Include the `harness` and `transcript` fields from the output in the issue.

## Recovered the wrong image from the right project

The output lists images oldest to newest, so the **last** entry is the most recent paste. Entries carry `filename` when the harness stored one: match on that when the user mentioned a name. `--count 3` gives you more to choose from.

## recover-paste: overriding detection and output location

`recover-paste` auto-detects which harness it runs inside (process ancestry first, then environment fingerprints) and reads only that harness's storage. Two knobs override it:

- **`MODLENS_HARNESS`** forces the storage scope without a flag: `claude-code`, `pi`, `opencode`, `codex`, or `none` (scan every store, no scoping). Detection reads it first, so it wins over ancestry and env fingerprints. `--harness` does the same for a single run.
- **`--out-dir`** sets where recovered images land. By default each run mints a fresh, unpredictable `<tmpdir>/modlens-paste-*` directory (0700, holding 0600 files), so nobody can pre-create a shared path to intercept the bytes. Point it elsewhere when the system temp dir is not where you want them. An explicit `--out-dir` that already exists is rejected unless it is a real directory (not a symlink), owned by you, with no group or world access. On Windows those ownership and permission checks are skipped, since the platform has no POSIX bits (see the Windows section below). The symlink guard still applies.

## This is a Codex session

```
This is a Codex session: pasted images already exist as temp files, and each image
tag in the message carries its path.
```

Working as intended. Codex writes pasted images to disk and puts the path in the message, so read the path out of the tag instead of recovering anything.

## The openai provider rejected a result

```
OpenAI-compatible API returned JSON that does not match the vision schema
(wrong or missing: visual.notes, ...)
```

That endpoint returned something the contract does not accept. Note the
wording: a field named here can be absent, or present with the wrong shape.
For an optional field like `visual.notes`, only the second is possible, since
leaving it out is accepted. A `null` there is dropped rather than refused, so
what remains is a genuinely wrong type.

Most OpenAI-compatible gateways enforce nothing server-side, so the contract
travels as a filled-in JSON template in the prompt and a weaker model can
answer with half of it, especially with thinking turned off. Ask the gateway
to enforce it instead:

```bash
modlens config set openai.structuredOutput true
```

That sends the contract as `response_format: json_schema` in strict form,
derived from the same schema modlens checks against, so there is nothing to
keep in sync by hand. It is off by default because a gateway that does not
support the field answers 400 for it. If that happens:

```bash
modlens config set openai.structuredOutput false
```

A `response_format` you set yourself in `extraBody` wins over the derived one.

Failing that, retry once, then switch:

```bash
modlens -i <image> -p gemini-api
```

## The guard said deny, or a read was refused

```
Invocation guard denied this read: active model "gemini-3.1-pro" matches guards.denyModels pattern "gemini-3*". A model with native vision should read the image itself. To override, unset MODLENS_MODEL or edit guards in /Users/you/.modlens/config.json.
```

Working as configured: `guards.denyModels` in the config file lists vision-capable models, and the active model matched one, so the engine refused to spend a provider call on an image that model can read itself. `modlens doctor` has a Guard section showing the rules, which model was detected, from which signal (the `MODLENS_MODEL` env var, session storage, or a `--model` self-report), and the verdict.

If the detection is wrong, `MODLENS_MODEL=<actual-model> modlens guard` overrides everything, and `MODLENS_MODEL=none` marks the model as unknown (the verdict then follows `denyWhenUnknown`, default allow). To turn the guard off entirely: `modlens config set guards.denyModels ''`.

One known blind spot: storage detection reads the newest assistant turn recorded for this project, so two sessions running different models in the same project directory at the same time can shadow each other (Claude Code and Codex pin the exact session through their injected session ids, Pi and OpenCode cannot). When that bites, `MODLENS_MODEL` is the override.

Note that the hard refusal above only fires on an actual `denyModels` match against the explicit `MODLENS_MODEL` value. Storage detection and the `denyWhenUnknown` policy never block `analyze`, they only speak through `modlens guard`, whose deny is advice to the agent rather than a locked door.

## dsh says "declares no dsh.bundle — installed as a plain dependency"

The dsh profile installed an old modlens version. The `dsh.bundle` declaration
exists since 3.9.0, and pnpm 11 holds back releases published in the last 24
hours (`minimumReleaseAge`, on by default since 11.0; `pnpm config get` does not
surface this particular default, so it prints nothing for it). When
every version carrying the declaration was inside that window, pnpm silently
resolved to an older one, which has no declaration, so dsh correctly treated it
as a plain dependency and none of the tools appeared.

`@latest` does not avoid this, which earlier versions of this page got wrong.
The gate filters the candidate versions before the tag is resolved, so the tag
simply lands on an older one. Name the exact version instead, which pnpm treats
as a deliberate request rather than a resolution:

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> add @liustack/modlens@3.26.1
```

`npm view @liustack/modlens version` prints the current one. pnpm 11 installs a named
version, and since 11.1.3 also records it as an approved exception in the
profile's `pnpm-workspace.yaml`, leaving every other package and every future
modlens release behind the window.

If you set `minimumReleaseAge` yourself, pnpm treats the policy as strict and
refuses instead, naming the version and the cutoff
(`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). Approve that one version in the same
file:

```yaml
minimumReleaseAgeExclude:
  - '@liustack/modlens@3.26.1'
```

Or lift the gate for a single command, which lifts it for everything that
command resolves, not only modlens:

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> add @liustack/modlens@latest --config.minimumReleaseAge=0
```

dsh's reconcile notices the bundle declaration on the new version and activates
it; restart dsh afterwards. Verify with
`npx -y @deepseek-ai/dsh plugin --profile <name> list`.

## dsh: the model cannot see the read_image tool

The plugin registers its tool as `modlens_read_image`, not `read_image`. dsh's
tool registry is layered, and a scoped tool shadows a global one: a host
`read_image` mounted in the agent-preset scope and a plugin's registered
globally are not a duplicate at all, so the registration succeeds silently and
the model still resolves the host's, which refuses a text-only model outright
([#34](https://github.com/liustack/modlens/issues/34)). Under our own name
there is nothing to shadow it, and the model finds the tool through its
schema, which reaches it on every request regardless of the name.

If the model still cannot see it, check the harness log for
`[modlens] ... registration skipped`. `toolName` in the plugin row pins a
different name, but pick one nothing else uses: any name a scoped tool already
holds will be shadowed exactly the way `read_image` is, which puts you back in
this section.

```yaml
- id: modlens
  config:
    toolName: vision_read_image
```

## fetch failed, or could not connect

```
Could not connect to generativelanguage.googleapis.com (UND_ERR_CONNECT_TIMEOUT). The request never reached the network. ...
```

The API request never left the machine. On networks that reach the internet
through a proxy this is expected: Node's fetch ignores the proxy environment
variables by default. modlens honors them once you ask it to route that way,
in either form:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 modlens -i shot.png -p gemini-api   # env (NO_PROXY honored too)
modlens config set proxy http://127.0.0.1:7890                        # persistent, all API providers
modlens config set openai.proxy http://127.0.0.1:7890                 # one provider only
modlens config set openai.proxy ""                                    # this provider connects directly
```

The provider field has three states. Missing inherits the shared config or
environment proxy, an empty string means direct, and a URL is a provider-only
proxy. This matters when an internet provider needs the shared proxy but an
internal endpoint must stay direct. Failover still tries both providers, but a
shared dead proxy otherwise makes both attempts fail the same way.

The proxy applies to API provider requests only. The remote-image download
path keeps its direct, IP-pinned connection on purpose: its SSRF guards
validate the exact address being contacted, and a proxy would blind them. On
a proxied machine, prefer local files or let the failover chain hand remote
URLs to a provider that fetches them upstream.

## Config file problems

```
Cannot read /Users/you/.modlens/config.json: EACCES ... Fix the file or its permissions.
```

The file exists but is unreadable. A missing file is fine, so this is a real problem rather than something to ignore.

```
Failed to parse ... Fix or delete the file.
```

Invalid JSON. `modlens config init --force` writes a clean one, losing the old contents.

## Timeouts

```
antigravity-cli provider timed out after 210000 ms.
```

Retry once with `--timeout 300000`. Dense images on agy legitimately take 15-40 seconds, and `-m gemini-3.1-pro-high` is slower still. Engines that ignore SIGTERM are escalated to SIGKILL, so a timeout returns promptly regardless.

## Every read is slow on a reasoning model

A model that thinks by default spends its budget before it starts transcribing, which a vision read does not need. There is no `--no-thinking` flag because each vendor names the switch differently, so pass the vendor's own field:

```bash
modlens config set openai.extraBody '{"thinking":{"type":"disabled"}}'
modlens -i shot.png --extra-body '{"reasoning_effort":"low"}'    # one run only
```

The per-vendor spellings, which models cannot turn it off at all, and how to tell whether the field actually landed are in [Configuration](../skills/modlens/references/configure.md#turning-thinking-off).

```
extraBody cannot override "messages" for the openai provider
```

That field carries the image, the prompt, or the schema enforcement. Remove it and keep the vendor knobs. A 400 from the gateway naming a field you set means that endpoint uses a different spelling, and a run on `antigravity-cli` or `claude-cli` says in `meta.warnings` that it ignored the value, since a CLI provider has no request body.

## Windows

ModLens runs on Windows. Three platform differences are worth knowing:

- **No POSIX permission checks.** Windows files carry no owner, group, or world bits (they read back as `0o666`/`0o777`, with access governed by ACLs), so `doctor` does not judge the config file's mode and `recover-paste --out-dir` does not reject a directory on ownership or group/world access. The symlink guard on `--out-dir` still applies.
- **Harness detection uses environment fingerprints.** There is no `ps` to read the process tree, so detection relies on the environment variables each harness sets. If a run guesses wrong, force it with `--harness <name>` or `MODLENS_HARNESS`.
- **Paste recovery.** OpenCode recovery is covered on Windows (issue #11). The Claude Code and Pi JSONL paths depend on `os.homedir()` and each harness's on-disk slug there. If recovery comes up empty, pass `--transcript` at the file, or drag the image into the terminal.

## Still stuck

Include the exact command and the full error in an issue: https://github.com/liustack/modlens/issues
