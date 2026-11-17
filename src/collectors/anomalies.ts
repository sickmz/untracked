import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, listDir, tilde } from '../lib/fs'
import type { Context, Item } from '../types'

export type Limits = {
  // Deepest directory read, the home being depth 0.
  depth: number
  // Deepest directory checked for piled-up versions.
  version_depth: number
  // The walk stops after this many entries or this many milliseconds.
  entries: number
  ms: number
  // Direct entries that make a directory crowded.
  crowded: number
  // Version-like child directories that make a pile-up.
  versions: number
}

const LIMITS: Limits = { depth: 8, version_depth: 4, entries: 2_000_000, ms: 4000, crowded: 10_000, versions: 4 }
const ZOMBIE_THRESHOLD = 20
const SKIPPED = new Set(['.git', 'node_modules', '.cache'])
const VERSION_NAMES = [/^v?\d+(\.\d+){1,3}([-+][\w.]+)?$/, /^.+-[0-9a-f]{12,}$/i]
// A UUID or a bare hash names a session or a stored object, not a version.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PACKAGE_NAME = /@v?\d/

export async function collectAnomalies(ctx: Context): Promise<Item[]> {
  const [walked, zombies] = await Promise.all([findCrowded(ctx, LIMITS), findZombies('/proc', ZOMBIE_THRESHOLD)])
  return [...walked, ...zombies]
}

// One bounded breadth-first walk of the home: crowded directories, version pile-ups, and a note
// when the walk stopped early. Unlike other collectors it enters git checkouts.
export async function findCrowded(ctx: Context, limits: Limits): Promise<Item[]> {
  const items: Item[] = []
  const queue = [{ dir: ctx.home, depth: 0 }]
  const started = Date.now()
  let entries = 0
  for (let index = 0; index < queue.length; index++) {
    if (entries >= limits.entries || Date.now() - started >= limits.ms) {
      items.push(stopItem(entries))
      break
    }
    const { dir, depth } = queue[index]!
    const children = await listDir(dir)
    entries += children.length
    const key = tilde(ctx.home, dir)
    if (children.length >= limits.crowded) {
      items.push(dirItem('crowded', key, `${children.length} entries`))
    }
    const sub_dirs = children.filter((child) => child.isDirectory()).map((child) => child.name)
    if (depth <= limits.version_depth) {
      const versions = countVersions(sub_dirs)
      if (versions >= limits.versions) {
        items.push(dirItem('versions', key, `${versions} versions kept`))
      }
    }
    if (depth >= limits.depth) continue
    for (const name of sub_dirs) {
      if (SKIPPED.has(name)) continue
      // The macOS counterpart of ~/.cache.
      if (depth === 1 && name === 'Caches' && key === '~/Library') continue
      queue.push({ dir: join(dir, name), depth: depth + 1 })
    }
  }
  return items
}

// A package cache ("name@1.2.3") keeps versions on purpose: it is not a pile-up.
function countVersions(names: string[]): number {
  if (names.some((name) => PACKAGE_NAME.test(name))) return 0
  return names.filter((name) => !UUID.test(name) && VERSION_NAMES.some((pattern) => pattern.test(name))).length
}

function dirItem(type: string, key: string, detail: string): Item {
  const item = anomaly(`${type}:${key}`, key, detail)
  item.path = key
  return item
}

function stopItem(entries: number): Item {
  return anomaly('walk-stopped', 'scan stopped early', `the scan stopped after ${entries} entries, so some directories were not checked`)
}

// Zombie processes from a /proc tree, reported when there are at least `threshold` of them.
export async function findZombies(proc_dir: string, threshold: number): Promise<Item[]> {
  if (!(await exists(proc_dir))) return []
  const pids = (await listDir(proc_dir)).filter((entry) => /^\d+$/.test(entry.name)).map((entry) => entry.name)
  const parents = new Map<string, number>()
  let total = 0
  for (const pid of pids) {
    const process_stat = await readStat(join(proc_dir, pid, 'stat'))
    if (process_stat?.state !== 'Z') continue
    total++
    parents.set(process_stat.ppid, (parents.get(process_stat.ppid) ?? 0) + 1)
  }
  if (total < threshold) return []

  let parent = ''
  let count = 0
  for (const [ppid, children] of parents) {
    if (children <= count) continue
    parent = ppid
    count = children
  }
  const command = (await readText(join(proc_dir, parent, 'comm')))?.trim() || 'an unknown process'
  return [
    anomaly(
      'zombies',
      'zombie processes',
      `${total} zombie processes, ${count} of them children of ${command} (pid ${parent})`,
    ),
  ]
}

// "pid (command) state ppid ...": the command may hold spaces and parentheses, so parse from the last ")".
async function readStat(file: string): Promise<{ state: string; ppid: string } | null> {
  const text = await readText(file)
  if (text == null) return null
  const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)
  const state = fields[0]
  const ppid = fields[1]
  if (state == null || ppid == null) return null
  return { state, ppid }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    // The process exited while it was being read.
    return null
  }
}

function anomaly(key: string, name: string, detail: string): Item {
  return { id: `anomaly:${key}`, kind: 'anomaly', category: 'anomaly', name, detail, fingerprint: '' }
}
