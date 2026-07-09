# Contributing to zcode-plugin-cc

Thanks for your interest in contributing! This plugin is a community-maintained
port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc),
swapping the engine from Codex to ZCode. Contributions of all sizes are welcome.

## Ways to contribute

- 🐛 **Report bugs** — open an issue with a clear reproduction.
- 💡 **Suggest enhancements** — open an issue describing the use case first,
  before writing code, so we can align on the approach.
- 🔧 **Submit pull requests** — fix a bug or implement an agreed feature.
- 📝 **Improve docs** — README clarity, examples, translations.

## Before you start

1. **Open an issue first** for anything beyond a small fix or doc tweak. This
   avoids duplicated work and ensures the change fits the project's direction.
2. This is a **derivative work** of an Apache-2.0 licensed project. All
   contributions will be licensed under Apache-2.0 as well (see below).

## Development setup

Requirements:

- Node.js 18.18 or later
- Git

```bash
git clone https://github.com/jackdaidai/zcode-plugin-cc.git
cd zcode-plugin-cc
npm install   # only needed if you add dependencies; currently dependency-free
npm test      # runs the Node.js built-in test runner
```

The test suite lives in `tests/*.test.mjs` and uses Node's built-in
[`node:test`](https://nodejs.org/api/test.html) runner — no extra test framework.

## Pull request process

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b fix/describe-the-change
   ```
2. **Keep changes focused** — one logical change per PR makes review faster.
3. **Add or update tests** for any change to behavior in `tests/`.
4. **Run the test suite** before pushing:
   ```bash
   npm test
   ```
5. **Open a PR** against `main` and fill in the PR template.
6. **Address review feedback** — push additional commits to the same branch.

### How PRs get merged

- All PRs are reviewed by the maintainer. There is no auto-merge.
- PRs are merged via **squash merge** to keep the commit history linear.
- If a PR has been stale for >30 days with no activity, it may be closed; you
  can always reopen it.

## Code style

- ESM (`type: "module"` in `package.json`).
- Match the existing style in the file you're editing — naming, spacing,
  comment density.
- No ESLint/Prettier is configured; keep it simple.

## Licensing

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE), the same license as the upstream project. You
retain your copyright (recorded via Git commit authorship).

## Attribution

This project is a derivative work of OpenAI's `codex-plugin-cc`. See
[`NOTICE`](./NOTICE) for the full attribution and a description of the
substantial modifications made.
