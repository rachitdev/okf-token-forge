# OKF-Token Forge

A separate plugin that compiles a repository into an [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle at `.okf/` and answers with a short slice. No model calls. DeepSeek Harness, Antigravity, Gemini, and Claude can use it. Decision Forge and Skillforge do not own it.

| Neighbor | Owns | Does not own |
|---|---|---|
| OKF-Token Forge | `.okf/` compile, lint, status, and a budgeted slice | Decisions, skill routing |
| Skillforge | When to load `skills/okf-token-forge/SKILL.md` | The repository graph |
| Decision Forge | Typed choice, score, or refusal | Walking or writing the repo |

## Commands

```bash
node bin/okf-token-forge.mjs compile --root "$PWD"
node bin/okf-token-forge.mjs query --root "$PWD" --budget 3500 -- auth session
node bin/okf-token-forge.mjs status --root "$PWD"
node bin/okf-token-forge.mjs lint --root "$PWD"
```

`query` refreshes files whose content hash or resolved local edge changed, then caps the answer (200–20000 characters, default 3500). Concepts hold symbols, line counts, and local links (`./`, Rust `mod`, Python `from .`). They do not hold source text. `node_modules`, `target`, `.git`, and lockfiles are skipped.

`status` prints JSON. `compiled` is false until a bundle exists. When it is true, `producer` is `process:okf-token-forge/0.1.0`, `newestSourceMtime` is the newest indexed file time, and `sourceCharactersNotInDefaultQuery` is indexed source bytes minus 3500. That last field is an upper bound against one default query, not a measured session saving. `lintOk` false means do not trust the slice until `lint` is clean.

Concepts are `generated` by `process:okf-token-forge/0.1.0` and are not `verified`. Use the map to choose a file, then open that file.

## DeepSeek Harness

This directory is a Cordis bundle. `index.js` registers a system-prompt section under 700 characters plus `okf_query` and `okf_compile`. `root` defaults to `process.cwd()`. The plugin does nothing until a profile installs this package.

## Other harnesses

`skills/okf-token-forge/SKILL.md` tells the agent to run the CLI. If the CLI is absent, read `.okf/index.md` and then one concept. Do not load the bundle.

## Tests

```bash
node --test test/*.test.mjs
```
