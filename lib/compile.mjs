import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { assertNoSymlinks, atomicWrite, withBundleLock } from "./fs-safe.mjs"
import { conceptDoc, encodeRepoPath, encodeSegment, isoUtc, mdLabel, PRODUCER, safeRelative, sourceUri } from "./text.mjs"

const SKIP_DIRS = new Set([
  ".git", ".okf", ".hg", ".svn", "node_modules", "target", "dist", "build",
  "vendor", "__pycache__", ".venv", "venv", "coverage", ".next", "out",
  ".turbo", ".cache",
])
const SOURCE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go",
  ".java", ".kt", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".cs", ".swift", ".sh",
])
const GUIDE_NAMES = new Set(["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "SKILL.md"])
const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
  "go.sum", ".DS_Store",
])
const MAX_BYTES = 256 * 1024
const MAX_SYMBOLS = 40
const LANG = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".py": "Python", ".rs": "Rust", ".go": "Go",
  ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby", ".php": "PHP", ".c": "C", ".h": "C",
  ".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".swift": "Swift", ".sh": "Shell",
}

export async function compileRepo(rootInput, options = {}) {
  const root = await realDir(rootInput)
  const out = path.join(root, ".okf")
  await prepareBundleDir(out)
  if (options.locked) return compileLocked(root, out, options)
  return withBundleLock(out, () => compileLocked(root, out, options))
}

async function compileLocked(root, out, options) {
  await assertNoSymlinks(out)

  const files = await walk(root)
  const byPath = new Map(files.map((file) => [file.rel, file]))
  const statePath = path.join(out, ".state.json")
  const previous = await readState(statePath)
  const next = { version: 1, files: {} }
  let conceptsWritten = 0
  let conceptsKept = 0
  let conceptsRemoved = 0
  const concepts = []

  for (const file of files) {
    const conceptRel = `files/${file.rel}.md`
    const abs = path.join(out, conceptRel)
    const neighbors = neighborsOf(file, byPath)
    const links = neighbors.map((neighbor) => neighbor.rel).join("\n")
    const doc = renderConcept(file, neighbors)
    const prev = previous.files?.[file.rel]
    const unchanged = prev?.sha256 === file.sha256 && prev?.links === links && (await readIf(abs)) === doc
    next.files[file.rel] = { sha256: file.sha256, concept: conceptRel, mtimeMs: file.mtimeMs, links }
    concepts.push({ ...file, conceptRel, abs, unchanged, neighbors, doc })
    if (unchanged) conceptsKept += 1
  }

  if (options.afterScan) await options.afterScan()

  for (const file of concepts) {
    if (file.unchanged) continue
    await atomicWrite(file.abs, file.doc)
    conceptsWritten += 1
  }

  for (const [rel, meta] of Object.entries(previous.files ?? {})) {
    if (next.files[rel]) continue
    const abs = path.join(out, meta.concept)
    if (!inside(out, abs)) continue
    const stat = await lstatOrNull(abs)
    if (stat?.isSymbolicLink()) throw new Error(`refusing symlink in OKF bundle: ${abs}`)
    if (stat?.isFile()) {
      await fs.rm(abs)
      conceptsRemoved += 1
    }
  }
  const overview = renderOverview(files, concepts)
  const overviewAbs = path.join(out, "repository.md")
  const overviewChanged = (await readIf(overviewAbs)) !== overview
  if (overviewChanged) await atomicWrite(overviewAbs, overview)

  const indexPaths = await writeIndexes(out, concepts)
  const indexesWritten = indexPaths.length
  await removeStaleIndexes(out, indexPaths)
  await removeStrayMarkdown(out, new Set([
    ...concepts.map((file) => file.abs),
    overviewAbs,
    path.join(out, "index.md"),
    path.join(out, "log.md"),
    ...indexPaths,
  ]))
  await pruneEmpty(path.join(out, "files"))
  const changed = conceptsWritten + conceptsRemoved + (overviewChanged ? 1 : 0)
  const logUpdated = changed > 0
    ? await prependLog(out, { conceptsWritten, conceptsKept, conceptsRemoved, scanned: files.length })
    : false
  const stateText = `${JSON.stringify(next, null, 2)}\n`
  if ((await readIf(statePath)) !== stateText) await atomicWrite(statePath, stateText)

  return {
    root,
    out,
    scanned: files.length,
    concepts: concepts.length + 1,
    conceptsWritten,
    conceptsKept,
    conceptsRemoved,
    indexesWritten,
    logUpdated,
    overviewChanged,
  }
}

async function walk(root) {
  const found = []
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        await visit(abs)
        continue
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name) || entry.name.startsWith(".")) continue
      const rel = safeRelative(path.relative(root, abs).split(path.sep).join("/"))
      const classified = classify(entry.name)
      if (!classified) continue
      const stat = await fs.stat(abs)
      if (stat.size > MAX_BYTES) continue
      const buf = await fs.readFile(abs)
      if (buf.subarray(0, 1024).includes(0)) continue
      const text = buf.toString("utf8")
      found.push({
        rel,
        abs,
        name: entry.name,
        ext: path.extname(entry.name),
        kind: classified,
        sha256: createHash("sha256").update(buf).digest("hex"),
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
        text,
      })
    }
  }
  await visit(root)
  found.sort((a, b) => a.rel.localeCompare(b.rel))
  return found
}

function classify(name) {
  if (GUIDE_NAMES.has(name)) return "guide"
  if (name === "package.json" || name === "Cargo.toml" || name === "go.mod" || name === "pyproject.toml") {
    return "manifest"
  }
  if (SOURCE_EXT.has(path.extname(name))) return "source"
  return null
}

function renderConcept(file, neighbors) {
  const lang = LANG[file.ext] ?? "Text"
  const symbols = file.kind === "source" ? extractSymbols(file) : []
  const lines = file.text.split(/\r?\n/).length
  const title = file.rel
  const description = describe(file, lang, symbols.length, lines)
  const fields = {
    type: file.kind === "guide" ? "Guide" : file.kind === "manifest" ? "Package manifest" : "Source file",
    title,
    description,
    resource: sourceUri(file.rel),
    tags: tagsFor(file, lang),
    status: "stable",
    path: file.rel,
    sources: [{ id: "origin", resource: sourceUri(file.rel), title: file.rel }],
    generated: { by: PRODUCER, at: isoUtc(file.mtimeMs) },
  }
  const body = []
  body.push(`# ${file.kind === "guide" ? "Excerpt" : "Structure"}`, "")
  body.push(description, "")
  if (symbols.length) {
    body.push("# Symbols", "")
    for (const symbol of symbols) body.push(`- \`${symbol.name}\` (${symbol.kind}, line ${symbol.line})`)
    body.push("")
  }
  if (file.kind === "manifest") {
    body.push("# Identity", "", manifestBlurb(file), "")
  }
  body.push("# Neighbors", "")
  if (neighbors.length === 0) body.push("_No resolved local import._")
  for (const neighbor of neighbors) {
    body.push(`- [${mdLabel(neighbor.rel)}](/files/${encodeRepoPath(neighbor.rel)}.md)`)
  }
  body.push("", "_Structural extract only. Open the source file for exact text._")
  return conceptDoc(fields, body.join("\n"))
}

function renderOverview(files, concepts) {
  const counts = { source: 0, manifest: 0, guide: 0 }
  const tops = new Map()
  let newest = 0
  for (const file of files) {
    counts[file.kind] += 1
    const top = file.rel.split("/")[0]
    tops.set(top, (tops.get(top) ?? 0) + 1)
    newest = Math.max(newest, file.mtimeMs)
  }
  const ranked = [...tops.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const description = `${files.length} indexed files (${counts.source} source, ${counts.manifest} manifests, ${counts.guide} guides). Structure only.`
  const fields = {
    type: "Repository",
    title: "Repository structure",
    description,
    tags: ["overview"],
    status: "stable",
    generated: { by: PRODUCER, at: isoUtc(newest) },
  }
  const lines = ["# Shape", "", description, "", "# Top levels", ""]
  if (ranked.length === 0) lines.push("_No indexable files._")
  for (const [name, count] of ranked.slice(0, 20)) {
    const href = concepts.some((c) => c.rel === name)
      ? `/files/${encodeRepoPath(name)}.md`
      : `/files/${encodeRepoPath(name)}/index.md`
    lines.push(`- [${mdLabel(name)}](${href}) — ${count} ${count === 1 ? "file" : "files"}`)
  }
  lines.push("", "# How to read", "", "Query by topic and open a source file only when this graph is not enough. The bundle does not contain source text.", "")
  return conceptDoc(fields, lines.join("\n"))
}

function describe(file, lang, symbolCount, lines) {
  if (file.kind === "guide") return `Guide ${file.rel}, ${lines} lines on disk. No guide text is copied.`
  if (file.kind === "manifest") return `Package manifest ${file.rel}.`
  return `${lang} source file, ${symbolCount} symbols, ${lines} lines.`
}

function tagsFor(file, lang) {
  const tags = [file.kind]
  if (file.kind === "source") tags.push(lang.toLowerCase())
  const top = file.rel.split("/")[0]
  if (top && top !== file.rel) tags.push(top.toLowerCase())
  return tags
}

function extractSymbols(file) {
  const patterns = patternsFor(file.ext)
  const found = []
  const lines = file.text.split(/\r?\n/)
  for (let i = 0; i < lines.length && found.length < MAX_SYMBOLS; i++) {
    const line = lines[i]
    for (const [kind, re] of patterns) {
      const match = re.exec(line)
      if (match) {
        found.push({ kind, name: match[1], line: i + 1 })
        break
      }
    }
  }
  return found
}

function patternsFor(ext) {
  if (ext === ".rs") {
    return [
      ["function", /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/],
      ["struct", /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z0-9_]+)/],
      ["enum", /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z0-9_]+)/],
      ["trait", /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z0-9_]+)/],
      ["type", /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z0-9_]+)/],
      ["module", /^mod\s+([A-Za-z0-9_]+)\s*;/],
    ]
  }
  if (ext === ".py") {
    return [
      ["class", /^class\s+([A-Za-z0-9_]+)/],
      ["function", /^(?:async\s+)?def\s+([A-Za-z0-9_]+)/],
    ]
  }
  if (ext === ".go") {
    return [
      ["type", /^type\s+([A-Za-z0-9_]+)/],
      ["function", /^func\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)/],
    ]
  }
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"].includes(ext)) {
    return [
      ["class", /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)/],
      ["function", /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/],
      ["interface", /^(?:export\s+)?interface\s+([A-Za-z0-9_]+)/],
      ["type", /^(?:export\s+)?type\s+([A-Za-z0-9_]+)/],
      ["enum", /^(?:export\s+)?enum\s+([A-Za-z0-9_]+)/],
      ["const", /^export\s+(?:const|let|function)\s+([A-Za-z0-9_]+)/],
    ]
  }
  return [["symbol", /^(?:export\s+)?(?:function|class|def|fn|func)\s+([A-Za-z0-9_]+)/]]
}

function neighborsOf(file, byPath) {
  const links = new Set()
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"].includes(file.ext)) {
    const re = /(?:from|import|require)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g
    for (const match of file.text.matchAll(re)) {
      const hit = resolveJs(file.rel, match[1], byPath)
      if (hit) links.add(hit)
    }
  } else if (file.ext === ".rs") {
    const lines = file.text.split(/\r?\n/)
    const baseDir = rustModuleBase(file.rel)
    for (let i = 0; i < lines.length; i++) {
      const match = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z0-9_]+)\s*;/.exec(lines[i])
      if (!match) continue
      const previous = lines.slice(0, i).reverse().find((line) => line.trim())
      if (previous?.includes("#[path")) continue
      const base = baseDir ? `${baseDir}/${match[1]}` : match[1]
      if (byPath.has(`${base}.rs`)) links.add(`${base}.rs`)
      else if (byPath.has(`${base}/mod.rs`)) links.add(`${base}/mod.rs`)
    }
  } else if (file.ext === ".py") {
    const dir = path.posix.dirname(file.rel)
    for (const match of file.text.matchAll(/^from\s+\.([A-Za-z0-9_]+)\s+import/gm)) {
      const base = dir === "." ? match[1] : `${dir}/${match[1]}`
      if (byPath.has(`${base}.py`)) links.add(`${base}.py`)
    }
  }
  return [...links].sort().map((rel) => ({ rel }))
}

function resolveJs(fromRel, spec, byPath) {
  const dir = path.posix.dirname(fromRel)
  const base = path.posix.normalize(path.posix.join(dir, spec))
  if (base.startsWith("..")) return null
  const candidates = [
    base,
    `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
    `${base}/index.js`, `${base}/index.ts`, `${base}/index.mjs`,
  ]
  return candidates.find((candidate) => byPath.has(candidate)) ?? null
}

function manifestBlurb(file) {
  if (file.name === "package.json") {
    try {
      const json = JSON.parse(file.text)
      return `name ${json.name ?? "unknown"}; description ${oneLine(json.description ?? "")}`
    } catch {
      return "package.json could not be parsed."
    }
  }
  if (file.name === "Cargo.toml") {
    const name = /(?<=^name\s*=\s*")[^"]+/m.exec(file.text)?.[0] ?? "unknown"
    return `cargo package ${name}`
  }
  if (file.name === "go.mod") {
    const mod = /^module\s+(\S+)/m.exec(file.text)?.[1] ?? "unknown"
    return `go module ${mod}`
  }
  return file.name
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").slice(0, 160)
}

async function writeIndexes(out, concepts) {
  const dirs = new Map()
  const ensure = (rel) => {
    if (!dirs.has(rel)) dirs.set(rel, { files: [], children: new Set() })
    return dirs.get(rel)
  }
  ensure("files")
  for (const concept of concepts) {
    const parts = concept.conceptRel.split("/")
    let acc = "files"
    for (let i = 1; i < parts.length - 1; i++) {
      ensure(acc).children.add(parts[i])
      acc = `${acc}/${parts[i]}`
      ensure(acc)
    }
    ensure(acc).files.push(concept)
  }
  const paths = [path.join(out, "index.md")]
  const root = [
    "---",
    'okf_version: "0.2"',
    "---",
    "",
    "# Repository",
    "",
    "* [Repository structure](repository.md) - structural overview; open a topic before source files",
    "",
    "# Files",
    "",
    "* [files](files/index.md) - one directory level at a time",
    "",
  ].join("\n")
  await writeIfChanged(path.join(out, "index.md"), root)

  for (const [dir, node] of dirs) {
    const lines = [`# ${dir}`, ""]
    for (const child of [...node.children].sort()) {
      lines.push(`* [${mdLabel(child)}](${encodeSegment(child)}/index.md) - subdirectory`)
    }
    for (const item of node.files.sort((a, b) => a.rel.localeCompare(b.rel))) {
      const name = path.posix.basename(item.conceptRel)
      lines.push(`* [${mdLabel(item.rel)}](${encodeSegment(name)}) - ${item.kind}`)
    }
    lines.push("")
    const indexPath = path.join(out, dir, "index.md")
    paths.push(indexPath)
    await writeIfChanged(indexPath, lines.join("\n"))
  }
  return paths
}

async function prependLog(out, summary) {
  const logPath = path.join(out, "log.md")
  const day = new Date().toISOString().slice(0, 10)
  const entry = `* **Update**: Compiled ${summary.scanned} files, wrote ${summary.conceptsWritten}, kept ${summary.conceptsKept}, removed ${summary.conceptsRemoved}.`
  let body = await readIf(logPath)
  if (!body) {
    body = `# Directory Update Log\n\n## ${day}\n${entry}\n`
  } else if (body.includes(`## ${day}\n`)) {
    body = body.replace(`## ${day}\n`, `## ${day}\n${entry}\n`)
  } else {
    body = body.replace("# Directory Update Log\n", `# Directory Update Log\n\n## ${day}\n${entry}\n`)
  }
  const sections = body.split(/\n(?=## )/)
  const head = sections[0]
  const rest = sections.slice(1, 31)
  const trimmed = [head, ...rest].join("\n").replace(/\n{3,}/g, "\n\n")
  await atomicWrite(logPath, trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`)
  return true
}

async function writeIfChanged(file, text) {
  const normalized = text.endsWith("\n") ? text : `${text}\n`
  if ((await readIf(file)) === normalized) return false
  await atomicWrite(file, normalized)
  return true
}

async function pruneEmpty(dir) {
  if (!(await exists(dir))) return
  const entries = await fs.readdir(dir)
  await Promise.all(entries.map(async (name) => {
    const abs = path.join(dir, name)
    const stat = await fs.lstat(abs)
    if (stat.isDirectory() && !stat.isSymbolicLink()) await pruneEmpty(abs)
  }))
  const left = await fs.readdir(dir)
  if (left.length === 0 && path.basename(dir) !== ".okf") await fs.rmdir(dir)
}

async function readState(file) {
  try {
    const json = JSON.parse(await fs.readFile(file, "utf8"))
    return json && typeof json === "object" ? json : { files: {} }
  } catch {
    return { files: {} }
  }
}

async function readIf(file) {
  try { return await fs.readFile(file, "utf8") } catch { return null }
}

async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
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

function rustModuleBase(rel) {
  const base = path.posix.basename(rel)
  const dir = path.posix.dirname(rel)
  if (base === "lib.rs" || base === "main.rs" || base === "mod.rs") return dir === "." ? "" : dir
  return dir === "." ? base.slice(0, -3) : `${dir}/${base.slice(0, -3)}`
}

async function prepareBundleDir(out) {
  const existing = await lstatOrNull(out)
  if (existing?.isSymbolicLink()) throw new Error(`refusing symlink in OKF bundle: ${out}`)
  if (existing && !existing.isDirectory()) throw new Error(`.okf is not a directory: ${out}`)
  await fs.mkdir(out, { recursive: true })
}

async function lstatOrNull(file) {
  try { return await fs.lstat(file) } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function removeStaleIndexes(out, expected) {
  const keep = new Set(expected.map((file) => path.resolve(file)))
  async function visit(dir) {
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink()) throw new Error(`refusing symlink in OKF bundle: ${abs}`)
      if (stat.isDirectory()) await visit(abs)
      else if (entry.name === "index.md" && !keep.has(path.resolve(abs))) await fs.rm(abs)
    }
  }
  await visit(out)
}

async function removeStrayMarkdown(out, expected) {
  const keep = new Set([...expected].map((file) => path.resolve(file)))
  async function visit(dir) {
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink()) throw new Error(`refusing symlink in OKF bundle: ${abs}`)
      if (stat.isDirectory()) await visit(abs)
      else if (entry.name.endsWith(".md") && !keep.has(path.resolve(abs))) await fs.rm(abs)
    }
  }
  await visit(out)
}

