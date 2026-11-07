import { promises as fs } from "node:fs"
import path from "node:path"

const LOCK_WAIT_MS = 30_000
const LOCK_STALE_MS = 1_000

/** Refuse a bundle directory that contains a symlink at any depth. */
export async function assertNoSymlinks(dir) {
  let stat
  try {
    stat = await fs.lstat(dir)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink in OKF bundle: ${dir}`)
  if (!stat.isDirectory()) return
  for (const name of await fs.readdir(dir)) {
    await assertNoSymlinks(path.join(dir, name))
  }
}

/** Replace a file without following a symlink and without exposing a partial write. */
export async function atomicWrite(file, text) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  await assertNoSymlinks(dir)
  let existing
  try {
    existing = await fs.lstat(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (existing?.isSymbolicLink()) throw new Error(`refusing symlink in OKF bundle: ${file}`)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  const handle = await fs.open(tmp, "w", 0o644)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, file)
}

/**
 * One compiler at a time for a bundle directory.
 * The directory must already exist and must not itself be a symlink.
 */
export async function withBundleLock(out, fn) {
  const stat = await fs.lstat(out)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing symlink in OKF bundle: ${out}`)
  }
  const lockPath = path.join(out, ".lock")
  const deadline = Date.now() + LOCK_WAIT_MS
  let handle
  while (handle === undefined) {
    try {
      handle = await fs.open(lockPath, "wx")
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (await lockIsStale(lockPath)) {
        await fs.rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error("OKF-Token Forge compile is already running for this bundle")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    await handle.writeFile(String(process.pid))
    return await fn()
  } finally {
    await handle.close()
    await fs.rm(lockPath, { force: true })
  }
}

async function lockIsStale(lockPath) {
  let stat
  try {
    stat = await fs.lstat(lockPath)
  } catch (error) {
    return error.code === "ENOENT"
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return true
  if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false
  let pid = NaN
  try {
    pid = Number((await fs.readFile(lockPath, "utf8")).trim())
  } catch {
    return true
  }
  return !pidAlive(pid)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}
