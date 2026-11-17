import { basename, dirname, join } from 'node:path'
import { listDir, readHead, tilde } from '../lib/fs'
import { distName, listDists, readCrates } from '../provenance'
import type { Context, Item } from '../types'

// Shipped with Node itself, not installed by the user.
const NODE_BUNDLED = new Set(['npm', 'corepack'])
// What a package manager accepts as a name. Anything else found on disk is not a package.
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

// Globally installed packages, read from each package manager's own files on disk.
export async function collectPackages(ctx: Context): Promise<Item[]> {
  const items = [
    ...(await npmPackages(ctx)),
    ...(await bunPackages(ctx)),
    ...(await pipPackages(ctx)),
    ...(await cargoPackages(ctx)),
  ]
  const unique = new Map<string, Item>()
  for (const item of items) {
    if (!PACKAGE_NAME.test(item.name)) continue
    if (!unique.has(item.id)) unique.set(item.id, item)
  }
  return [...unique.values()]
}

async function npmPackages(ctx: Context): Promise<Item[]> {
  const items: Item[] = []
  for (const dir of ctx.path_dirs) {
    if (!dir.startsWith(`${ctx.home}/`) || basename(dir) !== 'bin') continue
    const modules = join(dirname(dir), 'lib/node_modules')
    for (const name of await moduleNames(modules)) {
      if (NODE_BUNDLED.has(name)) continue
      items.push(packageItem('npm', name, tilde(ctx.home, join(modules, name))))
    }
  }
  return items
}

// "foo" and "@scope/bar" for each package folder of a node_modules directory.
async function moduleNames(modules: string): Promise<string[]> {
  const names: string[] = []
  for (const entry of await listDir(modules)) {
    if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue
    if (!entry.name.startsWith('@')) {
      names.push(entry.name)
      continue
    }
    for (const scoped of await listDir(join(modules, entry.name))) {
      if (!scoped.name.startsWith('.')) names.push(`${entry.name}/${scoped.name}`)
    }
  }
  return names
}

async function bunPackages(ctx: Context): Promise<Item[]> {
  const file = join(ctx.home, '.bun/install/global/package.json')
  const text = await readHead(file, 1024 * 1024)
  if (text === '') return []
  let manifest: { dependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(text)
  } catch {
    return []
  }
  const names = Object.keys(manifest.dependencies ?? {})
  return names.map((name) => packageItem('bun', name, tilde(ctx.home, file)))
}

async function pipPackages(ctx: Context): Promise<Item[]> {
  const dists = await listDists(ctx.home)
  return dists.map((dist) => {
    const name = distName(dist)
    return packageItem('pip', name)
  })
}

async function cargoPackages(ctx: Context): Promise<Item[]> {
  const crates = await readCrates(ctx.home)
  const file = tilde(ctx.home, join(ctx.home, '.cargo/.crates.toml'))
  return [...crates.keys()].map((crate) => packageItem('cargo', crate, file))
}

// `path` is left out where it would hold a version number.
function packageItem(manager: string, name: string, path?: string): Item {
  const item: Item = {
    id: `package:${manager}:${name}`,
    kind: 'package',
    category: 'manual',
    name,
    detail: `global ${manager} package`,
    origin: `${manager}:${name}`,
    fingerprint: '',
  }
  if (path != null) item.path = path
  return item
}
