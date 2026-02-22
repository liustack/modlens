---
summary: 'Testing Guide: Vitest usage, path constraints, coverage'
read_when:
  - Running tests
  - Writing tests
  - Troubleshooting test failures
---

# Testing Guide

## Key Constraints

**Must be run from the repository root** to avoid `globalSetup` and alias path mismatches.

## Commands

```bash
# Run all tests
pnpm test

# Run a single test file
pnpm exec vitest run <test-file-path>
```

## Pre-Test Checklist

- Ensure type checking passes for the relevant code
- Changes should include verifiable tests

## Directories

| Path | Purpose |
|------|---------|
| `test/` | Main test directory |
| `coverage/` | Coverage output |
