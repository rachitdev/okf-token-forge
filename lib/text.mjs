/**
 * Small, dependency-free helpers for OKF frontmatter and paths.
 * Strings are emitted as JSON scalars so YAML stays unambiguous.
 */

export const PRODUCER = "process:okf-token-forge/0.1.0"

export function isoUtc(ms) {
  const n = Number.isFinite(ms) ? ms : 0
  return new Date(n).toISOString().replace(/\.\d{3}Z$/, "Z")
}

export function quote(value) {
  return JSON.stringify(String(value))
}

function emit(key, value, indent) {
  const pad = " ".repeat(indent)
  if (value == null) return []
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`]
    const lines = [`${pad}${key}:`]
    for (const item of value) {
      if (item != null && typeof item === "object") {
        const entries = Object.entries(item).filter(([, v]) => v != null)
        if (entries.length === 0) continue
        const [firstKey, firstVal] = entries[0]
        if (firstVal != null && typeof firstVal === "object") {
          lines.push(`${pad}  - ${firstKey}:`)
        } else {
          lines.push(`${pad}  - ${firstKey}: ${scalar(firstVal)}`)
        }
        for (const [k, v] of entries.slice(1)) {
          if (v != null && typeof v === "object") continue
          lines.push(`${pad}    ${k}: ${scalar(v)}`)
        }
      } else {
        lines.push(`${pad}  - ${scalar(item)}`)
      }
    }
    return lines
  }
  if (typeof value === "object") {
    const lines = [`${pad}${key}:`]
    for (const [k, v] of Object.entries(value)) {
      if (v == null) continue
      lines.push(`${pad}  ${k}: ${scalar(v)}`)
    }
    return lines
  }
  return [`${pad}${key}: ${scalar(value)}`]
}

function scalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return quote(value)
}

/** Stable frontmatter. Key order is the object's insertion order. */
export function frontmatter(fields) {
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue
    lines.push(...emit(key, value, 0))
  }
  lines.push("---", "")
  return lines.join("\n")
}

export function conceptDoc(fields, body) {
  const text = `${frontmatter(fields)}${body.trim()}\n`
  return text
}

/** Repo-relative POSIX path. Rejects absolute paths and parent segments. */
export function safeRelative(rel) {
  const norm = String(rel).replaceAll("\\", "/").replace(/^\.\//, "")
  if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) {
    throw new Error(`unsafe relative path: ${rel}`)
  }
  return norm
}

/** Encode one path segment. Parentheses are encoded too; encodeURIComponent leaves them. */
export function encodeSegment(part) {
  return encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29")
}

export function encodeRepoPath(rel) {
  return safeRelative(rel).split("/").map((part) => encodeSegment(part)).join("/")
}

export function mdLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
}

export function sourceUri(rel) {
  return `okf-source:${encodeRepoPath(rel)}`
}
