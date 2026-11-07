import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { compileRepo } from "../lib/compile.mjs"
import { PROMPT_SECTION } from "../lib/guidance.mjs"
import { lintBundle } from "../lib/lint.mjs"
import { queryBundle } from "../lib/query.mjs"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "okf-token-forge-"))
  await mkdir(path.join(root, "src", "lib"), { recursive: true })
  await writeFile(path.join(root, "src", "auth.ts"), [
    "import { loadSession } from './session'",
    "export function verifyToken(raw) {",
    "  return raw",
    "}",
    "",
  ].join("\n"))
  await writeFile(path.join(root, "src", "session.ts"), [
    "export class Session {",
    "  id = 1",
    "}",
    "",
  ].join("\n"))
  await writeFile(path.join(root, "src", "lib", "store.py"), [
    "class Store:",
    "    def get(self):",
    "        return 1",
    "",
  ].join("\n"))
  await writeFile(path.join(root, "src", "lib.rs"), "mod child;\npub fn demo() {}\n")
  await writeFile(path.join(root, "src", "child.rs"), "pub struct Child {}\n")
  await writeFile(path.join(root, "README.md"), "# Demo\n\nAuth lives in src/auth.ts.\n")
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", description: "demo package" }))
  await mkdir(path.join(root, "node_modules", "left"), { recursive: true })
  await writeFile(path.join(root, "node_modules", "left", "index.js"), "export const secret = 1\n")
  return root
}

test("compile is conformant, incremental, and skips dependencies", async () => {
  const root = await fixture()
  try {
    const first = await compileRepo(root)
    assert.equal(first.conceptsWritten > 0, true)
    assert.equal(first.conceptsKept, 0)
    const lint = await lintBundle(first.out)
    assert.deepEqual(lint.problems, [])
    const auth = await readFile(path.join(first.out, "files", "src", "auth.ts.md"), "utf8")
    assert.match(auth, /^---\ntype: "Source file"/)
    assert.match(auth, /verifyToken/)
    assert.match(auth, /\/files\/src\/session\.ts\.md/)
    assert.equal(await exists(path.join(first.out, "files", "node_modules")), false)
    const rust = await readFile(path.join(first.out, "files", "src", "lib.rs.md"), "utf8")
    assert.match(rust, /\/files\/src\/child\.rs\.md/)
    const state = JSON.parse(await readFile(path.join(first.out, ".state.json"), "utf8"))
    assert.equal(Object.keys(state.files).some((rel) => rel.split("/").includes("node_modules")), false)
    const nested = await readFile(path.join(first.out, "files", "src", "index.md"), "utf8")
    assert.match(nested, /lib\/index\.md/)
    assert.doesNotMatch(nested, /^---/m)

    const second = await compileRepo(root)
    assert.equal(second.conceptsWritten, 0)
    assert.equal(second.conceptsRemoved, 0)
    assert.equal(second.conceptsKept > 0, true)

    await writeFile(path.join(root, "src", "auth.ts"), "export function verifyToken() { return false }\n")
    const third = await compileRepo(root)
    assert.equal(third.conceptsWritten, 1)
    const rewritten = await readFile(path.join(third.out, "files", "src", "auth.ts.md"), "utf8")
    assert.doesNotMatch(rewritten, /session\.ts/)

    await rm(path.join(root, "src", "child.rs"))
    const fourth = await compileRepo(root)
    assert.equal(fourth.conceptsRemoved, 1)
    assert.equal(await exists(path.join(fourth.out, "files", "src", "child.rs.md")), false)
    const parent = await readFile(path.join(fourth.out, "files", "src", "lib.rs.md"), "utf8")
    assert.doesNotMatch(parent, /child\.rs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("query stays inside the character budget and finds symbols", async () => {
  const root = await fixture()
  try {
    const wide = await queryBundle(root, "verifyToken", { budget: 3500 })
    assert.match(wide.text, /verifyToken/)
    assert.equal(wide.chars <= 3500, true)
    const tight = await queryBundle(root, "verifyToken session store demo", { budget: 280 })
    assert.equal(tight.truncated, true)
    assert.equal(tight.text.length <= 280, true)
    const overview = await queryBundle(root, "", { refresh: false })
    assert.match(overview.text, /Repository structure/)
    assert.equal(PROMPT_SECTION.length < 700, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function exists(file) {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

test("a new local import target rewrites the importer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-link-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "auth.ts"), "import { later } from './later'\nexport function verifyToken() {}\n")
    const first = await compileRepo(root)
    const before = await readFile(path.join(first.out, "files", "src", "auth.ts.md"), "utf8")
    assert.match(before, /No resolved local import/)
    await writeFile(path.join(root, "src", "later.ts"), "export function later() {}\n")
    const second = await compileRepo(root)
    assert.equal(second.conceptsWritten >= 2, true)
    const after = await readFile(path.join(second.out, "files", "src", "auth.ts.md"), "utf8")
    assert.match(after, /\/files\/src\/later\.ts\.md/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
