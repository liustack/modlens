---
summary: 'Security: what modlens runs, how recovered images are protected, image content as untrusted input'
read_when:
  - Reviewing what this tool does on your machine
  - Recovering pastes on a shared machine
  - Deciding how much to trust what a vision engine reports
---

# Security

## Recovered images are private

Images pulled out of session storage are written 0600 into a 0700 directory. On a shared machine with a common umask they would otherwise land world-readable, and a pasted screenshot can hold anything.

Recovery is also scoped to one project: the working directory recorded inside the transcript is checked, not just the directory name, because directory slugs collide (`/tmp/a.b` and `/tmp/a-b` produce the same one). A neighbouring project's images are never handed over.

## Permissions passed to engines

ModLens invokes `agy` with `--dangerously-skip-permissions` because prompt mode fails in some environments without it. The prompt restricts the agent to reading the one image it was given, and instructs it to treat image content strictly as data.

The `claude-cli` provider runs with `--allowedTools Read` only, so it can read local files and nothing else.

## Image content is untrusted input

Text inside an image is untrusted, the same as a web page. A screenshot can contain instructions aimed at whatever reads it. The prompt says so explicitly, but that is mitigation, not a guarantee: analyze images you are willing to open, and prefer a sandboxed working directory when they came from elsewhere.

## Evidence, not invention

What the engine cannot read goes into `uncertainty` rather than being filled in. v2 dropped pixel coordinates and confidence scores entirely, because those are the two fields models fabricate most convincingly.
