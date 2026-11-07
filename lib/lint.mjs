import { promises as fs } from "node:fs"
import path from "node:path"
import { parseFrontmatter } from "./query.mjs"

/** OKF v0.2 conformance check for the structural rules this cache must keep. */
export async function lintBundle(outInput) {
  const out = path.resolve(outInput)
  const problems = []
  let concepts = 0
  async function visit(dir) {
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (error) {
      problems.push(`unreadable ${dir}: ${error.message}`)
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        problems.push(`symlink not allowed: ${path.join(dir, entry.name)}`)
        continue
      }
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(abs)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      const raw = await fs.readFile(abs, "utf8")
      const rel = path.relative(out, abs).split(path.sep).join("/")
      if (entry.name === "index.md" || entry.name === "log.md") {
        checkReserved(rel, raw, problems)
        continue
      }
      concepts += 1
      const parsed = parseFrontmatter(raw)
      if (!parsed) problems.push(`${rel} missing frontmatter`)
      else if (!String(parsed.fields.type ?? "").trim()) problems.push(`${rel} missing type`)
    }
  }
  await visit(out)
  return { ok: problems.length === 0, problems, concepts }
}

function checkReserved(rel, raw, problems) {
  if (rel === "log.md") {
    if (!raw.startsWith("# Directory Update Log\n")) problems.push("log.md missing title")
    const dates = [...raw.matchAll(/^## (.+)$/gm)].map((match) => match[1])
    for (const date of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`log.md bad date ${date}`)
    }
    return
  }
  if (rel === "index.md") {
    if (!raw.startsWith("---\n")) {
      problems.push("bundle root index.md should declare okf_version")
      return
    }
    if (!raw.includes("okf_version:")) problems.push("index.md missing okf_version")
    const end = raw.indexOf("\n---\n")
    const yaml = end > 0 ? raw.slice(0, end) : raw
    if (/\ntype:/.test(`\n${yaml}`)) problems.push("index.md must not carry type")
    return
  }
  if (raw.startsWith("---\n")) problems.push(`${rel} index.md must not have frontmatter`)
}
