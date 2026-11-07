import { promises as fs } from "node:fs"
import path from "node:path"
import { lintBundle } from "./lint.mjs"
import { PRODUCER } from "./text.mjs"

const DEFAULT_QUERY_BUDGET = 3500

/**
 * Report whether a bundle exists and how it compares with one default query.
 * The character figure is an upper bound, not a measured session saving.
 */
export async function forgeStatus(rootInput) {
  const root = await realDir(rootInput)
  const out = path.join(root, ".okf")
  let bundleStat
  try { bundleStat = await fs.lstat(out) } catch { bundleStat = null }
  if (bundleStat?.isSymbolicLink()) throw new Error(`refusing symlink in OKF bundle: ${out}`)
  const statePath = path.join(out, ".state.json")
  const state = await readState(statePath)
  const hasState = await exists(statePath)
  const hasIndex = await exists(path.join(out, "index.md"))
  const indexed = Object.keys(state.files)
  if (!hasState || !hasIndex) {
    return {
      compiled: false,
      root,
      out,
      indexedFiles: 0,
      note: "No OKF-Token Forge bundle yet. Run compile or query.",
    }
  }
  let sourceBytes = 0
  let missingFiles = 0
  for (const rel of indexed) {
    const abs = path.join(root, rel)
    if (!inside(root, abs)) continue
    try {
      const stat = await fs.stat(abs)
      if (stat.isFile()) sourceBytes += stat.size
      else missingFiles += 1
    } catch {
      missingFiles += 1
    }
  }
  const bundleBytes = await markdownBytes(out)
  const lint = await lintBundle(out)
  const newest = indexed.reduce((max, rel) => Math.max(max, Number(state.files[rel]?.mtimeMs) || 0), 0)
  return {
    compiled: true,
    producer: PRODUCER,
    root,
    out,
    indexedFiles: indexed.length,
    newestSourceMtime: newest ? new Date(newest).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
    missingFiles,
    concepts: lint.concepts,
    lintOk: lint.ok,
    lintProblems: lint.problems,
    sourceBytes,
    bundleBytes,
    defaultQueryBudget: DEFAULT_QUERY_BUDGET,
    sourceCharactersNotInDefaultQuery: Math.max(0, sourceBytes - DEFAULT_QUERY_BUDGET),
    note: "sourceCharactersNotInDefaultQuery compares indexed source bytes with one default query budget. It is an upper bound, not a measured session saving.",
  }
}

async function markdownBytes(dir) {
  let total = 0
  async function visit(current) {
    let entries = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(abs)
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = await fs.stat(abs)
        total += stat.size
      }
    }
  }
  await visit(dir)
  return total
}

async function readState(file) {
  try {
    const json = JSON.parse(await fs.readFile(file, "utf8"))
    if (json && typeof json.files === "object" && json.files) return json
  } catch {
    // missing or unreadable state is an empty forge
  }
  return { files: {} }
}

async function realDir(input) {
  const abs = path.resolve(String(input ?? "."))
  const real = await fs.realpath(abs)
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw new Error(`not a directory: ${input}`)
  return real
}

function inside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}
