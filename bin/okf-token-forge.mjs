#!/usr/bin/env node
import path from "node:path"
import { compileRepo } from "../lib/compile.mjs"
import { lintBundle } from "../lib/lint.mjs"
import { queryBundle } from "../lib/query.mjs"
import { forgeStatus } from "../lib/status.mjs"

const [command, ...args] = process.argv.slice(2)

function option(name, fallback = undefined) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (value == null || value.startsWith("--")) {
    throw new Error(`${name} needs a value`)
  }
  return value
}

function positionals() {
  const skip = new Set()
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" || args[i] === "--budget") {
      skip.add(i)
      skip.add(i + 1)
    } else if (args[i] === "--") {
      skip.add(i)
    }
  }
  return args.filter((arg, index) => !skip.has(index))
}

function usage() {
  return [
    "Usage:",
    "  okf-token-forge compile [--root DIR]",
    "  okf-token-forge query [--root DIR] [--budget N] -- <terms>",
    "  okf-token-forge lint [--root DIR]",
    "  okf-token-forge status [--root DIR]",
    "",
    "Writes <root>/.okf. No model calls. Query refreshes changed files first.",
  ].join("\n")
}

try {
  const root = path.resolve(option("--root", process.cwd()))
  if (command === "compile") {
    const result = await compileRepo(root)
    console.log(JSON.stringify({
      scanned: result.scanned,
      conceptsWritten: result.conceptsWritten,
      conceptsKept: result.conceptsKept,
      conceptsRemoved: result.conceptsRemoved,
      out: result.out,
    }))
  } else if (command === "query") {
    const budget = option("--budget", "3500")
    const terms = positionals().join(" ")
    const result = await queryBundle(root, terms, { budget })
    process.stdout.write(result.text)
    if (!result.text.endsWith("\n")) process.stdout.write("\n")
  } else if (command === "status") {
    console.log(JSON.stringify(await forgeStatus(root)))
  } else if (command === "lint") {
    const result = await lintBundle(path.join(root, ".okf"))
    if (!result.ok) {
      console.error(result.problems.join("\n"))
      process.exitCode = 2
    } else {
      console.log(JSON.stringify({ ok: true, concepts: result.concepts }))
    }
  } else {
    console.error(usage())
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
