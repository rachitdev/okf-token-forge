import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { compileRepo } from "../lib/compile.mjs"
import { forgeStatus } from "../lib/status.mjs"

test("status reports an uncompiled root and then an upper bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-forge-"))
  try {
    const empty = await forgeStatus(root)
    assert.equal(empty.compiled, false)
    await mkdir(path.join(root, "src"))
    const source = `export function ${"token".repeat(80)}() { return 1 }\n`
    await writeFile(path.join(root, "src", "auth.ts"), source)
    await compileRepo(root)
    const status = await forgeStatus(root)
    assert.equal(status.compiled, true)
    assert.equal(status.producer, "process:okf-token-forge/0.1.0")
    assert.match(status.newestSourceMtime, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(status.lintOk, true)
    assert.equal(status.indexedFiles, 1)
    assert.equal(status.sourceBytes, Buffer.byteLength(source))
    assert.equal(status.defaultQueryBudget, 3500)
    assert.equal(status.sourceCharactersNotInDefaultQuery, Math.max(0, status.sourceBytes - 3500))
    assert.match(status.note, /upper bound/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
