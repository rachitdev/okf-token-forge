---
name: okf-token-forge
description: Save tokens by querying a self-updating OKF v0.2 codebase graph before reading source. Use when exploring a repository, locating a module, or avoiding a full-repo dump in DeepSeek Harness, Antigravity, Gemini, or Claude.
---

# OKF token cache

A repository may contain `.okf/`, an Open Knowledge Format v0.2 bundle compiled from the tree with no model calls. It stores file structure, symbols, and local import links. It does not store source text.

## Before reading lots of files

From the `okf-token-forge` package:

```bash
node bin/okf-token-forge.mjs query --root "$PWD" --budget 3500 -- <topic words>
```

Read that stdout. Open a source file only when the slice is not enough. Do not read every file under `.okf/`.

If the CLI is not installed, read `.okf/index.md` first, then one linked concept. Stop. Do not cat the bundle.

## Refresh

`query` recompiles files whose content hash changed and drops concepts for deleted files. There is no git hook. Do not call a model to regenerate the bundle.

```bash
node bin/okf-token-forge.mjs compile --root "$PWD"
node bin/okf-token-forge.mjs status --root "$PWD"
node bin/okf-token-forge.mjs lint --root "$PWD"
```

## Trust

Concepts are `generated` by `process:okf-token-forge/0.1.0` and are not `verified`. Treat them as a map, not as a review.
