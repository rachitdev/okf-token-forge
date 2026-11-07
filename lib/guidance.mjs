/** Short on purpose: the bundle stays on disk; the prompt only points at the tools. */
export const PROMPT_SECTION = [
  "OKF-Token Forge caches codebase structure as an OKF v0.2 bundle at .okf/ (markdown + YAML, no source text).",
  "Before opening many files, call okf_query with a few topic words and a character budget.",
  "Use okf_compile only when the bundle is missing or the tree changed and query was not called.",
  "The cache is a deterministic extract, not a review. Open the cited source file for exact code.",
  "Do not paste .okf/index.md or the whole bundle into the conversation.",
].join(" ")

if (PROMPT_SECTION.length > 700) {
  throw new Error(`prompt section is ${PROMPT_SECTION.length} chars; keep it under 700`)
}
