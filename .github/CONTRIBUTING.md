# Contributing to Traffic Atlas

## Before starting

1. Open or reference an issue for material behavior changes.
2. Create a focused branch from `main`.
3. Keep credentials, private keys, uploaded data, and generated artifacts out of Git.

## Development workflow

Install both dependency trees:

```bash
npm run install-all
```

Make the smallest coherent change and add tests at the lowest level that proves the behavior. Use
browser tests for user workflows, integration tests for module boundaries, and unit tests for
isolated logic.

Before opening a pull request, run:

```bash
npm run format
npm run verify
npm run test:e2e
```

## Pull requests

- Explain the user-visible behavior and important implementation decisions.
- List the checks you ran and any test or environment limitation.
- Include screenshots for visible interface changes.
- Keep unrelated refactors and formatting out of the pull request.
- Do not merge with failing or skipped required checks.

## JavaScript conventions

- Use two spaces for indentation.
- Use camel case for variables and functions and Pascal case for React components.
- Prefer small functions with explicit inputs and observable results.
- Validate input at API and process boundaries.
- Return stable, user-safe error messages; keep operational details in server logs.
- Comment decisions or constraints that are not evident from the code. Do not narrate the code.

ESLint and Prettier are the source of truth for mechanically enforceable style rules.

## Commit messages

Use an imperative summary no longer than 72 characters. Add a body when the reason or migration
impact is not obvious from the diff.
