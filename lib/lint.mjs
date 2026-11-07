import { promises as fs } from "node:fs"
import path from "node:path"
import { parseFrontmatter } from "./query.mjs"

/** OKF v0.2 checks for the bundle this compiler claims to write. */
export async function lintBundle(outInput) {
  const out = path.resolve(outInput)
  const problems = []
  let concepts = 0
  let rootStat
  try {
    rootStat = await fs.lstat(out)
  } catch (error) {
    return { ok: false, problems: [`missing bundle: ${error.message}`], concepts: 0 }
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { ok: false, problems: ["bundle root must be a real directory"], concepts: 0 }
  }
  const indexRaw = await readIf(path.join(out, "index.md"))
  const logRaw = await readIf(path.join(out, "log.md"))
  if (indexRaw == null) problems.push("missing index.md")
  else checkRootIndex(indexRaw, problems)
  if (logRaw == null) problems.push("missing log.md")
  else checkLog(logRaw, problems)

  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink()) {
        problems.push(`symlink not allowed: ${rel(out, abs)}`)
        continue
      }
      if (stat.isDirectory()) {
        await visit(abs)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      const raw = await fs.readFile(abs, "utf8")
      const relative = rel(out, abs)
      if (entry.name === "index.md") {
        if (relative !== "index.md") checkChildIndex(relative, raw, problems)
        await checkLinks(dir, raw, problems)
        continue
      }
      if (entry.name === "log.md") continue
      concepts += 1
      const parsed = parseFrontmatter(raw)
      if (!parsed) problems.push(`${relative} missing frontmatter`)
      else if (!String(parsed.fields.type ?? "").trim()) problems.push(`${relative} missing type`)
    }
  }
  await visit(out)
  return { ok: problems.length === 0, problems, concepts }
}

function checkRootIndex(raw, problems) {
  if (!raw.startsWith("---\n")) {
    problems.push("index.md missing frontmatter")
    return
  }
  const end = raw.indexOf("\n---\n")
  if (end < 0) {
    problems.push("index.md frontmatter is not closed")
    return
  }
  const yaml = raw.slice(4, end)
  if (!/^okf_version:\s*"0\.2"$/m.test(yaml)) problems.push('index.md okf_version must be "0.2"')
  if (/^type:/m.test(yaml)) problems.push("index.md must not carry type")
}

function checkChildIndex(relative, raw, problems) {
  if (raw.startsWith("---\n")) problems.push(`${relative} index.md must not have frontmatter`)
}

function checkLog(raw, problems) {
  if (!raw.startsWith("# Directory Update Log\n")) problems.push("log.md missing title")
  for (const match of raw.matchAll(/^## (.+)$/gm)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(match[1])) problems.push(`log.md bad date ${match[1]}`)
  }
}

async function checkLinks(dir, raw, problems) {
  for (const match of raw.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^[a-z]+:/i.test(target)) continue
    const decoded = target.split("#")[0].split("?")[0].split("/").map((part) => {
      try { return decodeURIComponent(part) } catch { return part }
    }).join("/")
    const abs = path.resolve(dir, decoded)
    try {
      await fs.lstat(abs)
    } catch {
      problems.push(`dangling link ${target}`)
    }
  }
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/")
}

async function readIf(file) {
  try { return await fs.readFile(file, "utf8") } catch { return null }
}
