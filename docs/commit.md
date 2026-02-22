---
summary: 'Git Commit Conventions: Conventional Commits format, atomic commits, HEREDOC usage'
read_when:
  - Preparing to commit code
  - Writing a commit message
  - Need to understand commit conventions
---

# Git Commit Conventions

## Commit Message Format

```
<type>[optional scope]: <imperative summary>

[optional body]

[optional footer(s)]
```

- Use imperative mood in summary, max 72 characters
- Do not end with a period
- Use scope only when it adds clarity (e.g., `auth`, `api`, `ui`)
- Mark breaking changes with `!` (e.g., `feat!:`) or a `BREAKING CHANGE:` footer

## Available Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation update |
| `style` | Formatting (no logic changes) |
| `refactor` | Code restructuring (no behavior changes) |
| `perf` | Performance improvement |
| `test` | Testing related |
| `build` | Build system or dependency changes |
| `ci` | CI/CD changes |
| `chore` | Maintenance tasks |
| `revert` | Revert a commit |

## Atomic Commit Principles

1. One commit does one thing
2. The repository should remain buildable/runnable after each commit
3. Each commit should be independently revertible, affecting only that specific change
4. Include related tests in the same commit when behavior changes
5. Do not mix refactoring/formatting with behavior changes

## Commit Workflow

```bash
# 1. Review changes
git status --short
git diff --staged --stat

# 2. Stage selectively (avoid git add -A)
git add <specific-files>

# 3. Review what will be committed
git diff --staged

# 4. Commit (HEREDOC format)
git commit -m "$(cat <<'EOF'
<type>[scope]: <summary>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

## Notes

- Do not commit sensitive files such as `.env` or credentials
- After a pre-commit hook failure, fix the issue and create a **new commit** (do not use `--amend`)
- Do not push automatically; wait for user instructions
