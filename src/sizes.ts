import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tilde } from './lib/fs'
import type { Context, Item, Kind } from './types'

// How deep directories are measured, and how deep "where the space is" looks.
const DEPTH = 6
export const SPACE_DEPTH = 3
export const LARGE = 1024 ** 3
const SPACE_ROWS = 15
// A child holding this share of a directory stands in for it.
const HEIR = 0.9
const MEASURED: Kind[] = ['binary', 'script', 'repo', 'dir', 'state_dir', 'anomaly']

// Adds the disk space of what the scan found, and the largest directories of the home.
// With no usage (du is missing, or took too long) items come back as they were.
export async function measure(ctx: Context, usage: Map<string, number>, items: Item[]): Promise<Item[]> {
  if (usage.size === 0) return items
  const sized = await Promise.all(items.map((item) => withSize(ctx, usage, item)))
  return [...sized, ...spaceItems(ctx.home, usage)]
}

// Bytes on disk of every directory of the home down to DEPTH, keyed by absolute path.
// The home is measured once, with du.
export async function diskUsage(ctx: Context): Promise<Map<string, number>> {
  let stdout: string
  try {
    stdout = (await ctx.run('du', ['-k', '-x', '-d', String(DEPTH), ctx.home])).stdout
  } catch {
    // du did not finish in time on a very large home: the report goes out without sizes.
    return new Map()
  }
  const usage = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const kilobytes = Number(line.slice(0, tab))
    if (Number.isFinite(kilobytes)) usage.set(line.slice(tab + 1), kilobytes * 1024)
  }
  return usage
}

async function withSize(ctx: Context, usage: Map<string, number>, item: Item): Promise<Item> {
  if (!MEASURED.includes(item.kind) || item.path == null || !item.path.startsWith('~')) return item
  const file = item.path === '~' ? ctx.home : join(ctx.home, item.path.slice(2))
  const size = usage.get(file) ?? (await fileSize(file))
  if (size == null) return item
  return { ...item, size }
}

// A link is not measured: its target is somewhere else, and often listed on its own.
async function fileSize(file: string): Promise<number | null> {
  const info = await lstat(file).catch(() => null)
  if (info == null || !info.isFile()) return null
  return info.blocks * 512
}

// The home and its largest directories, three levels deep. A directory whose space is almost
// all in one child is left out: the child says where the space really is.
export function spaceItems(home: string, usage: Map<string, number>): Item[] {
  const items: Item[] = []
  for (const [dir, size] of usage) {
    if (size < LARGE || (dir !== home && !dir.startsWith(`${home}/`))) continue
    const depth = dir === home ? 0 : dir.slice(home.length + 1).split('/').length
    if (depth > SPACE_DEPTH) continue
    if (depth > 0 && depth < SPACE_DEPTH && hasHeir(usage, dir, size)) continue
    const path = tilde(home, dir)
    items.push({ id: `space:${path}`, kind: 'space', category: 'space', name: path, detail: '', path, fingerprint: '', size })
  }
  return items.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, SPACE_ROWS)
}

function hasHeir(usage: Map<string, number>, dir: string, size: number): boolean {
  const prefix = `${dir}/`
  for (const [child, child_size] of usage) {
    if (!child.startsWith(prefix) || child.indexOf('/', prefix.length) !== -1) continue
    if (child_size >= size * HEIR) return true
  }
  return false
}
