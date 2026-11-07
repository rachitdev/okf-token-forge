import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

const toolsLib = path.resolve(import.meta.dirname, "../../../deepseek-harness/packages/core/tools/lib/index.js")

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@deepseek-ai/dsh-tools") {
      return { url: pathToFileURL(toolsLib).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

test("DSH plugin registers a short prompt and both tools", async (t) => {
  if (!existsSync(toolsLib)) {
    t.skip("local @deepseek-ai/dsh-tools build is not available")
    return
  }
  const { apply } = await import("../index.js")
  const sections = []
  const tools = []
  apply({
    effect(fn) { fn(); return () => {} },
    systemPrompt: { section(spec) { sections.push(spec); return () => {} } },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  })
  assert.deepEqual(tools.map((tool) => tool.name), ["okf_query", "okf_compile"])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, "okf-token-forge")
  assert.equal(sections[0].interpolate, false)
  assert.equal(sections[0].text.length < 700, true)
  assert.match(sections[0].text, /okf_query/)
})
