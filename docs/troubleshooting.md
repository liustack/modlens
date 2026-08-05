---
summary: 'Troubleshooting: every error modlens can print, what causes it, what to do'
read_when:
  - A run failed and the message is not self-explanatory
  - recover-paste found nothing, or found the wrong image
  - Deciding whether a failure is setup, quota, or a bug
---

# Troubleshooting

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
Provider CLI not found: agy. Install it and sign in first.
```

The binary is not on PATH, or `--provider-bin` points somewhere wrong.

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
- **A setup problem is blocking one harness.** Anything blocking appears after `Blocked:` in the same message, for example OpenCode needing Node 22.5+ for `node:sqlite`.

## recover-paste returned an image from another project

This should not happen any more, and if it does it is a bug worth reporting. Recovery checks the working directory recorded inside the transcript, not just the directory name, because directory slugs collide (`/tmp/a.b` and `/tmp/a-b` produce the same one). Include the `harness` and `transcript` fields from the output in the issue.

## Recovered the wrong image from the right project

The output lists images oldest to newest, so the **last** entry is the most recent paste. Entries carry `filename` when the harness stored one: match on that when the user mentioned a name. `--count 3` gives you more to choose from.

## recover-paste: overriding detection and output location

`recover-paste` auto-detects which harness it runs inside (process ancestry first, then environment fingerprints) and reads only that harness's storage. Two knobs override it:

- **`MODLENS_HARNESS`** forces the storage scope without a flag: `claude-code`, `pi`, `opencode`, `codex`, or `none` (scan every store, no scoping). Detection reads it first, so it wins over ancestry and env fingerprints. `--harness` does the same for a single run.
- **`--out-dir`** sets where recovered images land. It defaults to `<tmpdir>/modlens-paste`, a 0700 directory holding 0600 files. Point it elsewhere when the system temp dir is not where you want the bytes.

## This is a Codex session

```
This is a Codex session: pasted images already exist as temp files, and each image
tag in the message carries its path.
```

Working as intended. Codex writes pasted images to disk and puts the path in the message, so read the path out of the tag instead of recovering anything.

## The openai provider rejected a result

```
OpenAI-compatible API returned JSON that does not match the vision schema
(missing: ocr, ocr.full_text, ...)
```

That endpoint returned a partial result. Only agy, gemini-api, anthropic, and claude-cli enforce the schema server-side, so weaker gateways can produce half a result. Retry once, then switch:

```bash
modlens -i <image> -p gemini-api
```

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

## Still stuck

Include the exact command and the full error in an issue: https://github.com/liustack/modlens/issues
