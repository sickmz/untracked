import { readlink, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { hashFile, isExec, isRepo, listDir, tilde } from '../lib/fs'
import { readKind, resolveOrigin } from '../provenance'
import type { Context, Item } from '../types'

export const WALK_DEPTH = 3
export const WALK_LIMIT = 2000

// Executable files under the home, and who put each one there.
export async function collectBinaries(ctx: Context): Promise<Item[]> {
  const items: Item[] = []
  const seen = new Set<string>()

  for (const dir of binDirs(ctx)) {
    for (const entry of await sortedDir(dir)) {
      const file = join(dir, entry.name)
      if (seen.has(file) || entry.isDirectory()) continue
      if (entry.isSymbolicLink() && !(await targetExists(file))) {
        seen.add(file)
        items.push(await orphanItem(ctx, file))
        continue
      }
      if (!(await isExec(file))) continue
      seen.add(file)
      items.push(await fileItem(ctx, file))
    }
  }

  for (const file of await walkHome(ctx.home)) {
    if (seen.has(file)) continue
    seen.add(file)
    items.push(await fileItem(ctx, file))
  }
  return items
}

// PATH entries inside the home, plus ~/bin and ~/.local/bin.
function binDirs(ctx: Context): string[] {
  // A PATH entry inside node_modules was added by a project's script runner, not by the user.
  const inside = ctx.path_dirs.filter((dir) => dir.startsWith(`${ctx.home}/`) && !dir.includes('/node_modules'))
  return [...new Set([...inside, join(ctx.home, 'bin'), join(ctx.home, '.local/bin')])]
}

// Compiled programs and scripts directly in the home and in its top-level folders, bounded.
async function walkHome(home: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await sortedDir(home)) {
    const file = join(home, entry.name)
    if (entry.isDirectory()) {
      if (skipDir(entry.name) || (await isRepo(file))) continue
      files.push(...(await walkTop(file)))
      continue
    }
    if (await isProgram(file)) files.push(file)
  }
  return files
}

async function walkTop(top: string): Promise<string[]> {
  const files: string[] = []
  let left = WALK_LIMIT

  async function walk(dir: string, depth: number): Promise<void> {
    for (const entry of await sortedDir(dir)) {
      if (left <= 0) return
      left -= 1
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= WALK_DEPTH || skipDir(entry.name) || (await isRepo(file))) continue
        await walk(file, depth + 1)
        continue
      }
      if (await isProgram(file)) files.push(file)
    }
  }

  await walk(top, 1)
  return files
}

function skipDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

async function isProgram(file: string): Promise<boolean> {
  if (!(await isExec(file))) return false
  return (await readKind(file)) != null
}

// Sorted by name, so the entry limit cuts at the same place on every scan.
async function sortedDir(dir: string) {
  const entries = await listDir(dir)
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

async function targetExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function fileItem(ctx: Context, file: string): Promise<Item> {
  const kind = (await readKind(file)) ?? 'script'
  const found = await resolveOrigin(ctx, file)
  const path = tilde(ctx.home, file)
  const item: Item = {
    id: `${kind}:${path}`,
    kind,
    category: found.category,
    name: basename(file),
    detail: found.detail,
    path,
    fingerprint: found.category === 'manual' ? await hashFile(file) : '',
  }
  if (found.origin != null) item.origin = found.origin
  return item
}

async function orphanItem(ctx: Context, file: string): Promise<Item> {
  const target = await readlink(file)
  const path = tilde(ctx.home, file)
  return {
    id: `binary:${path}`,
    kind: 'binary',
    category: 'orphan',
    name: basename(file),
    detail: `link to ${tilde(ctx.home, resolve(dirname(file), target))}, which is missing`,
    path,
    fingerprint: target,
  }
}
