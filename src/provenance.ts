import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isVersioned, listDir, readHead, tilde } from './lib/fs'
import type { Category, Context } from './types'

export type Origin = {
  category: Category
  origin?: string
  detail: string
}

type Records = {
  // Absolute script path to the pip distribution that installed it.
  pip: Map<string, string>
  // Crate name to the binaries it installed.
  crates: Map<string, string[]>
}

const ELF = '7f454c46'
const MACH_O = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'])
const RECORD_BYTES = 4 * 1024 * 1024

const records_cache = new WeakMap<Context, Promise<Records>>()

// 'binary' for a compiled file, 'script' for text starting with "#!", null for anything else.
export async function readKind(file: string): Promise<'binary' | 'script' | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buffer, 0, 4, 0)
    const magic = buffer.subarray(0, bytesRead).toString('hex')
    if (magic === ELF || MACH_O.has(magic)) return 'binary'
    if (magic.startsWith('2321')) return 'script'
    return null
  } finally {
    await handle.close()
  }
}

// Who put an executable there. `file` is the entry as found, possibly a symlink.
export async function resolveOrigin(ctx: Context, file: string): Promise<Origin> {
  const home = await realHome(ctx)
  let real: string
  try {
    real = await realpath(file)
  } catch {
    return { category: 'orphan', detail: `${tilde(ctx.home, file)} points to a file that is missing` }
  }
  const kind = (await readKind(real)) ?? 'script'
  const is_link = (await lstat(file)).isSymbolicLink()
  const shown = tilde(home, real)

  if (!isInside(home, real)) return systemOrigin(ctx, real)

  const npm = npmOrigin(home, real)
  if (npm != null) return npm

  const records = await loadRecords(ctx)
  const managed = managerOrigin(home, real, records) ?? managerOrigin(home, file, records)
  if (managed != null) return managed

  const relative = shown.slice(2)
  // Installers keep their versions in hidden folders. A versioned path in a visible folder is the user's own.
  if (relative.startsWith('.') && isVersioned(relative)) {
    const name = installerName(relative)
    return { category: 'installed', origin: `installer:${name}`, detail: `${name} installer` }
  }

  const target = kind === 'script' ? await wrapperTarget(home, real) : null
  if (target != null) {
    const name = targetName(home, target)
    return {
      category: 'installed',
      origin: `installer:${name}`,
      detail: `${name} installer`,
    }
  }

  // An installer's bin folder holds compiled programs or the tool itself ("~/.acme/bin/acme").
  // Scripts with other names in such a folder ("~/.dotfiles/bin/deploy") are the user's own.
  const hidden = hiddenBin(tilde(ctx.home, file).slice(2)) ?? hiddenBin(relative)
  if (hidden != null && (kind === 'binary' || basename(real).startsWith(hidden))) {
    return { category: 'installed', origin: `installer:${hidden}`, detail: `${hidden} installer` }
  }

  if (is_link) return { category: 'manual', detail: `link to ${shown}` }
  return { category: 'manual', detail: '' }
}

// The pip distribution directories of the user's Python installs:
// "~/.local/lib/python3.12/site-packages" on Linux, "~/Library/Python/3.12/lib/python/site-packages" on macOS.
export async function listDists(home: string): Promise<string[]> {
  const sites: string[] = []
  const lib = join(home, '.local/lib')
  for (const python of await listDir(lib)) {
    if (python.name.startsWith('python')) sites.push(join(lib, python.name, 'site-packages'))
  }
  const library = join(home, 'Library/Python')
  for (const version of await listDir(library)) {
    sites.push(join(library, version.name, 'lib/python/site-packages'))
  }
  const dists: string[] = []
  for (const site of sites) {
    for (const entry of await listDir(site)) {
      if (entry.isDirectory() && entry.name.endsWith('.dist-info')) dists.push(join(site, entry.name))
    }
  }
  return dists
}

// "foo_bar-1.2.0.dist-info" becomes "foo_bar".
export function distName(dist: string): string {
  return basename(dist).replace(/\.dist-info$/, '').split('-')[0] ?? ''
}

// Crate name to binaries, from cargo's own record of what it installed.
export async function readCrates(home: string): Promise<Map<string, string[]>> {
  const text = await readHead(join(home, '.cargo/.crates.toml'), RECORD_BYTES)
  const crates = new Map<string, string[]>()
  for (const line of text.split('\n')) {
    const match = line.match(/^"(\S+) [^"]*"\s*=\s*\[(.*)\]/)
    const [, crate, list] = match ?? []
    if (crate == null || list == null) continue
    const bins = [...list.matchAll(/"([^"]+)"/g)].map((bin) => bin[1] ?? '')
    crates.set(crate, bins)
  }
  return crates
}

async function realHome(ctx: Context): Promise<string> {
  try {
    return await realpath(ctx.home)
  } catch {
    return ctx.home
  }
}

function isInside(home: string, file: string): boolean {
  return file === home || file.startsWith(`${home}/`)
}

async function systemOrigin(ctx: Context, real: string): Promise<Origin> {
  const formula = brewOwner(real)
  if (formula != null) return { category: 'managed', origin: `brew:${formula}`, detail: `Homebrew formula ${formula}` }
  const result = await ctx.run('dpkg', ['-S', real])
  const owner = result.code === 0 ? dpkgOwner(result.stdout) : null
  if (owner != null) return { category: 'managed', origin: `dpkg:${owner}`, detail: `system package ${owner}` }
  if (isVersioned(real)) {
    return { category: 'installed', origin: 'system', detail: `link to ${real}, a versioned install` }
  }
  return { category: 'manual', detail: `link to ${real}` }
}

// The formula or cask that owns a real path: "jq" in "/opt/homebrew/Cellar/jq/1.7.1/bin/jq".
export function brewOwner(real: string): string | null {
  const segments = real.split('/')
  const index = segments.findIndex((segment) => segment === 'Cellar' || segment === 'Caskroom')
  if (index < 0) return null
  return segments[index + 1] || null
}

// "jq: /usr/bin/jq" or "libfoo:amd64, libbar: /usr/lib/x" gives the first package name.
function dpkgOwner(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('diversion ')) continue
    const index = line.lastIndexOf(': ')
    if (index <= 0) continue
    const name = line.slice(0, index).split(',')[0]?.trim().split(':')[0]
    if (name) return name
  }
  return null
}

function npmOrigin(home: string, real: string): Origin | null {
  const segments = real.split('/')
  const index = segments.indexOf('node_modules')
  const first = segments[index + 1]
  if (index < 0 || first == null) return null
  const name = first.startsWith('@') ? `${first}/${segments[index + 2] ?? ''}` : first
  if (real.startsWith(`${home}/.bun/`)) return { category: 'managed', origin: `bun:${name}`, detail: `bun package ${name}` }
  return { category: 'managed', origin: `npm:${name}`, detail: `npm package ${name}` }
}

function managerOrigin(home: string, file: string, records: Records): Origin | null {
  const dist = records.pip.get(file)
  if (dist != null) return { category: 'managed', origin: `pip:${dist}`, detail: `pip package ${dist}` }

  const name = basename(file)
  if (dirname(file) === join(home, '.cargo/bin')) {
    for (const [crate, bins] of records.crates) {
      if (bins.includes(name)) return { category: 'managed', origin: `cargo:${crate}`, detail: `cargo crate ${crate}` }
    }
  }
  if (dirname(file) === join(home, 'go/bin')) return { category: 'managed', origin: `go:${name}`, detail: 'installed with go' }
  return null
}

function loadRecords(ctx: Context): Promise<Records> {
  const cached = records_cache.get(ctx)
  if (cached != null) return cached
  const records = readRecords(ctx)
  records_cache.set(ctx, records)
  return records
}

async function readRecords(ctx: Context): Promise<Records> {
  const home = await realHome(ctx)
  const pip = new Map<string, string>()
  for (const dist of await listDists(home)) {
    const text = await readHead(join(dist, 'RECORD'), RECORD_BYTES)
    const site = dirname(dist)
    for (const line of text.split('\n')) {
      const entry = (line.split(',')[0] ?? '').replace(/^"|"$/g, '')
      if (!entry.includes('bin/')) continue
      pip.set(resolve(site, entry), distName(dist))
    }
  }
  return { pip, crates: await readCrates(home) }
}

// The absolute, version-like path a tiny wrapper script hands over to with `exec`, or null.
async function wrapperTarget(home: string, file: string): Promise<string | null> {
  const lines = (await readHead(file, 4096))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  // A wrapper does one thing: a script with any other line of code is the user's own.
  const [line] = lines
  if (line == null || lines.length !== 1) return null
  const word = line.match(/^exec\s+("[^"]+"|'[^']+'|\S+)/)?.[1]
  if (word == null) return null
  const target = word.replace(/^["']|["']$/g, '').replace(/^(\$HOME|\$\{HOME\}|~)\//, `${home}/`)
  if (!target.startsWith('/')) return null
  if (!isInside(home, target)) return isVersioned(target) ? target : null
  const relative = tilde(home, target).slice(2)
  return relative.startsWith('.') && isVersioned(relative) ? target : null
}

function targetName(home: string, target: string): string {
  if (isInside(home, target)) return installerName(tilde(home, target).slice(2))
  // Outside the home, the folder just above the first version-like segment.
  const segments = target.split('/').filter((segment) => segment !== '')
  const index = segments.findIndex((segment) => isVersioned(segment))
  return segments[index - 1] ?? basename(target)
}

// The folder that holds the tool: "~/.local/share/acme-cli/…" or "~/.acme/…" gives "acme-cli" or "acme".
function installerName(relative: string): string {
  const [first = '', second, third] = relative.split('/')
  if (first === '.local' && third != null) return third
  if (first === '.config' && second != null) return second
  return first.replace(/^\./, '')
}

// "~/.acme/bin/acme" gives "acme". "~/.local/bin" is the user's own bin folder, not an installer's.
function hiddenBin(relative: string): string | null {
  const segments = relative.split('/')
  const [first = '', second] = segments
  if (segments.length !== 3 || second !== 'bin') return null
  if (!first.startsWith('.') || first === '.local') return null
  return first.slice(1)
}
