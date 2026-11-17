import { access, constants, readlink, realpath, stat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { basename, dirname, join, resolve } from 'node:path'
import { fromRoot, hashFile, isExec, isVersioned, listDir, readHead } from '../lib/fs'
import { readKind } from '../provenance'
import type { Context, Item } from '../types'
import { cleanUrl } from './home'
import { enabledUnits, UNIT_SUFFIXES, unitItem } from './services'

// What apt and snap accept as a package name.
const APT_NAME = /^[a-z0-9][a-z0-9+.-]+$/
const SNAP_NAME = /^[a-z0-9][a-z0-9-]*$/
// A history log larger than this is not apt's own.
const LOG_LIMIT = 64 * 1024 * 1024
// Entries of one system directory that are checked against the package database.
const ENTRY_LIMIT = 200
const APT_PROGRAMS = new Set(['apt', 'apt-get', 'aptitude'])
const ROTATED_LOG = /^history\.log\.\d+\.gz$/
const STANDARD_DIRS = new Set(['bin', 'sbin', 'lib', 'lib64', 'share', 'include', 'etc', 'src', 'games', 'man', 'libexec'])
const RUNTIME_SNAPS = /^(snapd|bare|core\d*)$/

type Scan = {
  ctx: Context
  root: string
  // The root with symlinks resolved, to show real paths without it.
  real_root: string
  packages: Set<string>
}

// An executable in /usr/local put there by an installer, and who that is.
type Installed = { real: string; origin: string; name: string }

// Hand-made things outside the home on Debian and Ubuntu: packages installed by an explicit
// command, package sources, /opt, /usr/local, system units and snaps.
export async function collectSystem(ctx: Context): Promise<Item[]> {
  if (ctx.root == null) return []
  // Without a package database nothing outside the home can be told apart from the system.
  const listed = await ctx.run('dpkg-query', ['-W', '-f', '${Package}\\n'])
  if (listed.code !== 0) return []
  const scan: Scan = {
    ctx,
    root: ctx.root,
    real_root: await realpath(ctx.root).catch(() => ctx.root ?? '/'),
    packages: new Set(listed.stdout.split('\n').filter((name) => name !== '')),
  }
  const groups = await Promise.all([
    collectApt(scan),
    collectSources(scan),
    collectOpt(scan),
    collectLocal(scan),
    collectUnits(scan),
    collectSnaps(scan),
  ])
  return groups.flat()
}

async function collectApt(scan: Scan): Promise<Item[]> {
  const dir = join(scan.root, 'var/log/apt')
  const born = (await stat(scan.ctx.home).catch(() => null))?.birthtimeMs ?? 0
  const texts = [await readLog(join(dir, 'history.log'))]
  for (const entry of await listDir(dir)) {
    if (entry.isFile() && ROTATED_LOG.test(entry.name)) texts.push(await readGzip(join(dir, entry.name)))
  }
  const names = new Set<string>()
  for (const text of texts) {
    for (const name of requested(text, born)) names.add(name)
  }
  return [...names]
    .filter((name) => scan.packages.has(name))
    .map((name): Item => ({
      id: `package:apt:${name}`,
      kind: 'package',
      category: 'manual',
      name,
      detail: 'apt package',
      origin: `apt:${name}`,
      fingerprint: '',
    }))
}

function readLog(file: string): Promise<string> {
  return readHead(file, LOG_LIMIT)
}

// '' for a file that is unreadable, damaged, or would unpack to more than LOG_LIMIT.
async function readGzip(file: string): Promise<string> {
  try {
    const info = await stat(file)
    if (info.size > LOG_LIMIT) return ''
    const bytes = await Bun.file(file).bytes()
    return gunzipSync(bytes, { maxOutputLength: LOG_LIMIT }).toString('utf8')
  } catch {
    return ''
  }
}

// Packages named by an install command in an apt history log, minus those pulled in
// automatically and those installed before `born` (while the system image was built).
function requested(text: string, born: number): string[] {
  const names: string[] = []
  let start = Number.NaN
  let command = ''
  for (const line of text.split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line)
    if (field == null) continue
    const [, key = '', value = ''] = field
    if (key === 'Start-Date') {
      start = new Date(value.trim().replace(/\s+/, 'T')).getTime()
      command = ''
      continue
    }
    if (key === 'Commandline') {
      command = value
      continue
    }
    if (key !== 'Install' || !isInstall(command)) continue
    if (born > 0 && start < born) continue
    names.push(...explicitNames(value))
  }
  return names
}

function isInstall(command: string): boolean {
  const words = command.trim().split(/\s+/)
  if (!APT_PROGRAMS.has(basename(words[0] ?? ''))) return false
  // An option may take a value ("-t backports install x"), so the verb is looked for, not assumed first.
  return words.slice(1).includes('install')
}

// "azure-cli:amd64 (2.90.0-1), libfoo:amd64 (1.2, automatic)" gives ["azure-cli"].
function explicitNames(value: string): string[] {
  const names: string[] = []
  for (const chunk of value.split(/\),\s*/)) {
    const open = chunk.indexOf(' (')
    if (open === -1) continue
    if (/\bautomatic\b/.test(chunk.slice(open))) continue
    const name = chunk.slice(0, open).trim().replace(/:[^:]*$/, '')
    if (APT_NAME.test(name)) names.push(name)
  }
  return names
}

async function collectSources(scan: Scan): Promise<Item[]> {
  const distro = await distroId(scan.root)
  const own = new Set([`${distro}.sources`, `${distro}.list`])
  const items: Item[] = []
  const lists = join(scan.root, 'etc/apt/sources.list.d')
  const sources = (await listDir(lists))
    .filter((entry) => entry.isFile() && !own.has(entry.name))
    .filter((entry) => entry.name.endsWith('.list') || entry.name.endsWith('.sources'))
    .map((entry) => join(lists, entry.name))
  for (const file of await unowned(scan, sources)) {
    items.push(await sourceItem(scan, file, sourceUrl(await readHead(file))))
  }
  const keyrings = join(scan.root, 'etc/apt/keyrings')
  const keys = (await listDir(keyrings)).filter((entry) => entry.isFile()).map((entry) => join(keyrings, entry.name))
  for (const file of await unowned(scan, keys)) items.push(await sourceItem(scan, file, ''))
  return items
}

async function distroId(root: string): Promise<string> {
  const text = await readHead(join(root, 'etc/os-release'))
  return /^ID=["']?([^"'\n]*)/m.exec(text)?.[1] ?? ''
}

async function sourceItem(scan: Scan, file: string, detail: string): Promise<Item> {
  const path = fromRoot(scan.root, file)
  return {
    id: `config:${path}`,
    kind: 'config',
    category: 'manual',
    name: basename(file),
    detail,
    path,
    fingerprint: await hashFile(file),
  }
}

// The first repository URL of a source file, without user, password or query string.
function sourceUrl(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#')) continue
    const deb822 = /^URIs:\s*(\S+)/i.exec(line)?.[1]
    const one_line = /^deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?(\S+)/.exec(line)?.[1]
    const url = deb822 ?? one_line
    if (url == null) continue
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? cleanUrl(url) : ''
  }
  return ''
}

async function collectOpt(scan: Scan): Promise<Item[]> {
  const dir = join(scan.root, 'opt')
  const items: Item[] = []
  const candidates = (await listDir(dir)).filter((entry) => !scan.packages.has(entry.name)).map((entry) => join(dir, entry.name))
  for (const file of await unowned(scan, candidates)) {
    // A file is not an installed tool, and a directory nobody else can read was made by a program for itself.
    if (!(await isDirectory(file)) || !(await isReadable(file))) continue
    items.push(dirItem(scan, file, null))
  }
  return items
}

async function collectLocal(scan: Scan): Promise<Item[]> {
  const local = join(scan.root, 'usr/local')
  const items: Item[] = []
  const installed: Installed[] = []
  for (const bin of ['bin', 'sbin']) {
    const dir = join(local, bin)
    for (const entry of await listDir(dir)) {
      const found = await programItem(scan, join(dir, entry.name), entry.isSymbolicLink())
      if (found == null) continue
      items.push(found.item)
      if (found.installer != null) installed.push(found.installer)
    }
  }
  for (const entry of await listDir(local)) {
    if (STANDARD_DIRS.has(entry.name) || !entry.isDirectory()) continue
    const dir = join(local, entry.name)
    const path = fromRoot(scan.root, dir)
    const owner = installed.find((program) => program.real.startsWith(`${path}/`)) ?? null
    items.push(dirItem(scan, dir, owner))
  }
  return items
}

// An executable directly in /usr/local/bin or /usr/local/sbin, with the installer that put it
// there, or null when it is not one.
async function programItem(
  scan: Scan,
  file: string,
  is_link: boolean,
): Promise<{ item: Item; installer: Installed | null } | null> {
  const path = fromRoot(scan.root, file)
  const real = is_link ? await realpath(file).catch((error: NodeJS.ErrnoException) => error.code ?? null) : file
  // Only a target that is not there makes the link an orphan: one that cannot be reached proves nothing.
  if (real === 'ENOENT') return { item: await orphanItem(scan, file), installer: null }
  if (real == null || !real.startsWith('/')) return null
  if (!(await isExec(real))) return null
  const kind = (await readKind(real)) === 'binary' ? 'binary' : 'script'
  const item: Item = {
    id: `${kind}:${path}`,
    kind,
    category: 'manual',
    name: basename(file),
    detail: '',
    path,
    fingerprint: '',
  }
  if (!is_link) {
    item.fingerprint = await hashFile(file)
    return { item, installer: null }
  }
  const shown = fromRoot(scan.real_root, real)
  if (isVersioned(shown)) {
    const name = installerName(shown, basename(file))
    item.category = 'installed'
    item.origin = `installer:${name}`
    item.detail = `${name} installer`
    return { item, installer: { real: shown, origin: item.origin, name } }
  }
  item.fingerprint = await hashFile(file)
  item.detail = `link to ${shown}`
  return { item, installer: null }
}

// The path segment just before the first version-like one: "acme-cli" in "/usr/local/acme-cli/v2/bin/acme".
function installerName(real: string, fallback: string): string {
  const segments = real.split('/')
  const at = segments.findIndex((segment) => segment !== '' && isVersioned(segment))
  return segments[at - 1] || fallback
}

async function orphanItem(scan: Scan, file: string): Promise<Item> {
  const path = fromRoot(scan.root, file)
  const target = fromRoot(scan.root, resolve(dirname(file), await readlink(file)))
  return {
    id: `binary:${path}`,
    kind: 'binary',
    category: 'orphan',
    name: basename(file),
    detail: `link to ${target}, which is missing`,
    path,
    fingerprint: target,
  }
}

function dirItem(scan: Scan, dir: string, owner: Installed | null): Item {
  const path = fromRoot(scan.root, dir)
  const item: Item = {
    id: `dir:${path}`,
    kind: 'dir',
    category: 'manual',
    name: path,
    detail: '',
    path,
    fingerprint: '',
  }
  if (owner == null) return item
  item.category = 'installed'
  item.origin = owner.origin
  item.detail = `${owner.name} installer`
  return item
}

async function collectUnits(scan: Scan): Promise<Item[]> {
  const dir = join(scan.root, 'etc/systemd/system')
  const enabled = await enabledUnits(dir)
  const items: Item[] = []
  const units = (await listDir(dir))
    // A symlink here only enables or aliases a packaged unit.
    .filter((entry) => entry.isFile() && UNIT_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
    .filter((entry) => !entry.name.startsWith('snap.') && !entry.name.startsWith('snap-'))
    .map((entry) => join(dir, entry.name))
  for (const file of await unowned(scan, units)) {
    items.push(await unitItem(scan.ctx, file, enabled.has(basename(file)), true))
  }
  return items
}

async function collectSnaps(scan: Scan): Promise<Item[]> {
  const seed = await readHead(join(scan.root, 'var/lib/snapd/seed/seed.yaml'))
  const seeded = new Set([...seed.matchAll(/^\s*-?\s*name:\s*["']?([^"'\s]+)/gm)].map((match) => match[1]))
  const items: Item[] = []
  for (const entry of await listDir(join(scan.root, 'snap'))) {
    const name = entry.name
    if (!entry.isDirectory() || name === 'bin' || seeded.has(name)) continue
    if (RUNTIME_SNAPS.test(name) || !SNAP_NAME.test(name)) continue
    // A snap with nothing to run (a theme, a shared runtime) came along with another one.
    const meta = await readHead(join(scan.root, 'snap', name, 'current/meta/snap.yaml'))
    if (meta !== '' && !/^apps:/m.test(meta)) continue
    items.push({
      id: `package:snap:${name}`,
      kind: 'package',
      category: 'manual',
      name,
      detail: 'snap package',
      origin: `snap:${name}`,
      fingerprint: '',
    })
  }
  return items
}

// The files no package owns, at most ENTRY_LIMIT of them, asked together so a full directory stays fast.
async function unowned(scan: Scan, files: string[]): Promise<string[]> {
  const checked = files.sort().slice(0, ENTRY_LIMIT)
  const owned = await Promise.all(checked.map((file) => isOwned(scan, file)))
  return checked.filter((_file, index) => !owned[index])
}

// True when dpkg says a package owns the file. dpkg is asked with the path as the user knows it.
async function isOwned(scan: Scan, file: string): Promise<boolean> {
  const result = await scan.ctx.run('dpkg', ['-S', fromRoot(scan.root, file)])
  return result.code === 0
}

async function isDirectory(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null)
  return info != null && info.isDirectory()
}

async function isReadable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.R_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}
