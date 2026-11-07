import { defineTool } from "@deepseek-ai/dsh-tools"
import { compileRepo } from "./lib/compile.mjs"
import { PROMPT_SECTION } from "./lib/guidance.mjs"
import { queryBundle } from "./lib/query.mjs"

export const name = "okf-token-forge"
export const inject = ["tools", "systemPrompt"]

const sliceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    chars: { type: "number", required: true },
    truncated: { type: "boolean", required: true },
    hits: { type: "number", required: true },
    text: { type: "string", required: true },
  },
}

/**
 * DSH host plugin. Antigravity and other harnesses use bin/okf-token-forge.mjs
 * plus skills/okf-token-forge/SKILL.md; they do not load this file.
 *
 * Contract: `root` defaults to process.cwd(), not a session workspace service.
 * okf_query refreshes .okf from content hashes before it answers. The model
 * should read `text` only; `chars` is already capped (200–20000, default 3500).
 * The bundle is an unverified structural extract. This package is not enabled
 * until the profile plugin manager installs it.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: "okf-token-forge",
    order: 8600,
    interpolate: false,
    text: PROMPT_SECTION,
  }))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: "okf_query",
    description: "Return a short OKF codebase slice for a topic. Refreshes only changed files. Prefer this over reading the repository.",
    parameters: {
      query: { type: "string", required: true, description: "A few topic words, such as auth session." },
      root: { type: "string", description: "Repository root. Defaults to the process working directory." },
      budget: { type: "number", description: "Max characters in the slice, from 200 to 20000. Default 3500." },
    },
    output: {
      schema: sliceSchema,
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args) {
      const result = await queryBundle(args.root || process.cwd(), args.query, { budget: args.budget })
      return {
        chars: result.chars,
        truncated: result.truncated,
        hits: result.hits.length,
        text: result.text,
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: "okf_compile",
    description: "Incrementally compile the repository into .okf without calling a model. okf_query already compiles when needed.",
    parameters: {
      root: { type: "string", description: "Repository root. Defaults to the process working directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scanned: { type: "number", required: true },
          conceptsWritten: { type: "number", required: true },
          conceptsKept: { type: "number", required: true },
          conceptsRemoved: { type: "number", required: true },
          out: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `OKF compile scanned ${value.scanned}, wrote ${value.conceptsWritten}, kept ${value.conceptsKept}, removed ${value.conceptsRemoved}.`,
      }],
    },
    async execute(args) {
      const result = await compileRepo(args.root || process.cwd())
      return {
        scanned: result.scanned,
        conceptsWritten: result.conceptsWritten,
        conceptsKept: result.conceptsKept,
        conceptsRemoved: result.conceptsRemoved,
        out: result.out,
      }
    },
  })))
}
