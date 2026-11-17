import type { Dirent } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const HASH_LIMIT = 512 * 1024 * 1024
const VERSION_SEGMENT = /^(v?\d+(\.\d+)+([-+.][\w.-]+)?|v\d+|current|latest|versions?)$/i

// "/home/u/scripts/x" becomes "~/scripts/x". Paths outside the home are returned unchanged.
export function tilde(home: string, file: string): string {
  if (file === home) return '~'
  if (file.startsWith(`${home}/`)) return `~${file.slice(home.length)}`
  return file
}

// A path below the system root as the user knows it. With the real root, "/", it is unchanged.
export function fromRoot(root: string, file: string): string {
  if (root === '/' || !file.startsWith(`${root}/`)) return file
  return file.slice(root.length)
}

// Entries of a directory, or [] when it is missing or unreadable.
// A name that is not valid UTF-8 cannot be turned back into a path, so it is left out.
export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => !entry.name.includes('\uFFFD'))
  } catch {
    return []
  }
}

// The first bytes of a file as text, or '' when it is missing or unreadable.
export async function readHead(file: string, bytes = 65536): Promise<string> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return ''
  }
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function hashText(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16)
}

// Content hash of a file, following symlinks. Very large files are identified by size instead.
// A file that cannot be read, or that vanished during the scan, gives 'unreadable'.
export async function hashFile(file: string): Promise<string> {
  try {
    const info = await stat(file)
    if (info.size > HASH_LIMIT) return `size:${info.size}`
    const hasher = new Bun.CryptoHasher('sha256')
    for await (const chunk of Bun.file(file).stream()) hasher.update(chunk)
    return hasher.digest('hex').slice(0, 16)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return 'unreadable'
    throw error
  }
}

// True for a regular file with an execute bit, following symlinks.
export async function isExec(file: string): Promise<boolean> {
  try {
    const info = await stat(file)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

// True when the directory is a git checkout. Collectors do not look inside one.
export function isRepo(dir: string): Promise<boolean> {
  return exists(join(dir, '.git'))
}

// True when a path has a segment that looks like a version: "2.1.326", "v2", "current", "versions".
// A file reached through such a path was put there by an installer or an updater.
export function isVersioned(file: string): boolean {
  return file.split('/').some((segment) => VERSION_SEGMENT.test(segment))
}
