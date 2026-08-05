# Security Policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue.

Use [GitHub Security Advisories](https://github.com/liustack/modlens/security/advisories/new) to open a private report. That keeps the details between you and the maintainers until a fix is out.

Include the exact command, the full output, and the modlens and Node versions, the same detail a bug report needs. We will acknowledge the report, work on a fix, and credit you unless you prefer otherwise.

## Supported versions

This is a fast-moving CLI. Fixes land on the latest published version on npm (`@liustack/modlens`), so upgrade to the newest release before reporting.

## What to keep in mind

modlens runs vision engines over images on your machine and can recover pasted image bytes from local session storage. The security model, what it runs, how recovered images are protected, and why image content is untrusted input, is documented in [docs/security.md](docs/security.md). Read it before reporting behavior that may be working as intended.
