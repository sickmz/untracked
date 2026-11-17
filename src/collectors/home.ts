import type { Dirent } from 'node:fs'
import { access, constants, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isIgnored } from '../ignore'
import { exists, hashFile, isRepo, listDir, readHead, tilde } from '../lib/fs'
import type { Context, Item } from '../types'

const CONFIG_LIMIT = 64 * 1024
const MIN_NAME = 2
// Shortest name that may claim a longer one with no separator in between ("kube" and "kubectl").
const MIN_PREFIX = 3
// Children of a visible directory examined for checkouts.
const CHILD_LIMIT = 1000

// Read by the shell collector.
const SHELL_FILES = [
  '.bashrc',
  '.bash_profile',
  '.bash_aliases',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
]

const NESTED_CONFIGS = ['.ssh/config', '.ssh/authorized_keys', '.aws/config', '.config/git/config']
// Never a key: what ssh itself keeps in ~/.ssh.
const SSH_OTHER = ['config', 'authorized_keys', 'known_hosts', 'known_hosts.old', 'environment', 'rc']

const CONTAINERS = ['.config', '.local/share', '.local/state']

// What the PATH directories hold, read once per scan.
type Commands = {
  names: string[]
  // Real path of an executable inside the home, and the command name that reaches it.
  targets: { file: string; command: string }[]
  // Real paths of the PATH directories.
  dirs: string[]
  // Names of the installed system packages.
  packages: string[]
}

export async function collectHome(ctx: Context): Promise<Item[]> {
  const commands = await readCommands(ctx)
  const items: Item[] = []
  for (const entry of await listDir(ctx.home)) {
    const found = entry.name.startsWith('.')
      ? await hiddenEntry(ctx, commands, entry.name)
      : await visibleEntry(ctx, join(ctx.home, entry.name))
    items.push(...found)
  }
  for (const container of CONTAINERS) {
    for (const entry of await listDir(join(ctx.home, container))) {
      const relative = `${container}/${entry.name}`
      if (isIgnored(relative)) continue
      const dir = join(ctx.home, relative)
      if (!(await isDirectory(dir))) continue
      items.push(await appItem(ctx, commands, dir))
    }
  }
  for (const relative of NESTED_CONFIGS) {
    const file = join(ctx.home, relative)
    if (await isConfig(file)) items.push(await configItem(ctx, file))
  }
  items.push(...(await sshKeys(ctx)))
  return items
}

// SSH keys by name. A key is told apart by its public half, or by the header of a private one;
// the private key itself is never hashed or stored.
async function sshKeys(ctx: Context): Promise<Item[]> {
  const dir = join(ctx.home, '.ssh')
  const names = (await listDir(dir)).filter((entry) => entry.isFile()).map((entry) => entry.name)
  const items: Item[] = []
  for (const name of names) {
    if (SSH_OTHER.includes(name)) continue
    if (name.endsWith('.pub')) {
      const key = name.slice(0, -4)
      const item = keyItem(ctx, join(dir, key), names.includes(key) ? '' : 'public half only')
      item.fingerprint = await hashFile(join(dir, name))
      items.push(item)
      continue
    }
    if (names.includes(`${name}.pub`)) continue
    const head = await readHead(join(dir, name), 64)
    if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(head)) items.push(keyItem(ctx, join(dir, name), 'no public half next to it'))
  }
  return items
}

function keyItem(ctx: Context, file: string, detail: string): Item {
  const path = tilde(ctx.home, file)
  return { id: `key:${path}`, kind: 'key', category: 'manual', name: path.slice(2), detail, path, fingerprint: '' }
}

async function hiddenEntry(ctx: Context, commands: Commands, name: string): Promise<Item[]> {
  if (SHELL_FILES.includes(name)) return []
  if (isIgnored(name)) return []
  const file = join(ctx.home, name)
  const info = await stat(file).catch(() => null)
  if (info == null) return []
  if (info.isDirectory()) return [await appItem(ctx, commands, file)]
  if (!info.isFile()) return []
  // A file we cannot read (often left behind by sudo) can be neither compared nor hashed.
  if (!(await isReadable(file))) return []
  if (await isSkel(ctx, file, name)) return []
  // Programs write JSON; people write rc, ini, toml and yaml files.
  if (!name.endsWith('.json') && (await isConfig(file))) return [await configItem(ctx, file)]
  return [await appItem(ctx, commands, file)]
}

async function visibleEntry(ctx: Context, dir: string): Promise<Item[]> {
  if (isIgnored(basename(dir))) return []
  if (!(await isDirectory(dir))) return []
  if (await isRepo(dir)) return [await repoItem(ctx, dir)]
  const items: Item[] = []
  const children = (await listDir(dir)).slice(0, CHILD_LIMIT)
  for (const child of children) {
    const child_dir = join(dir, child.name)
    if (!(await isChildDir(child, child_dir))) continue
    if (await isRepo(child_dir)) items.push(await repoItem(ctx, child_dir))
  }
  const path = tilde(ctx.home, dir)
  items.push({
    id: `dir:${path}`,
    kind: 'dir',
    category: 'manual',
    name: path.slice(2),
    detail: '',
    path,
    fingerprint: '',
  })
  return items
}

async function configItem(ctx: Context, file: string): Promise<Item> {
  const path = tilde(ctx.home, file)
  return {
    id: `config:${path}`,
    kind: 'config',
    category: 'manual',
    name: path.slice(2),
    detail: '',
    path,
    fingerprint: await hashFile(file),
  }
}

async function appItem(ctx: Context, commands: Commands, file: string): Promise<Item> {
  const path = tilde(ctx.home, file)
  const origin = await claimant(commands, file)
  const item: Item = {
    id: `state_dir:${path}`,
    kind: 'state_dir',
    category: 'unclaimed',
    name: path.slice(2),
    detail: '',
    path,
    fingerprint: '',
  }
  if (origin == null) return item
  item.category = 'installed'
  item.detail = `kept by ${origin.slice(origin.indexOf(':') + 1)}`
  item.origin = origin
  return item
}

async function repoItem(ctx: Context, dir: string): Promise<Item> {
  const path = tilde(ctx.home, dir)
  const url = await originUrl(dir)
  const item: Item = {
    id: `repo:${path}`,
    kind: 'repo',
    category: 'manual',
    name: path.slice(2),
    detail: 'no remote',
    path,
    fingerprint: url ?? '',
  }
  if (url == null) return item
  item.origin = url
  item.detail = url
  return item
}

// What accounts for an application directory or state file: "app:<command>", "dpkg:<package>", or null.
async function claimant(commands: Commands, file: string): Promise<string | null> {
  const real = await realpath(file).catch(() => file)
  const name = basename(file).replace(/^\./, '').toLowerCase()
  if (commands.names.includes(name)) return `app:${name}`
  const target = commands.targets.find((entry) => isInside(real, entry.file))
  if (target != null) return `app:${target.command}`
  if (commands.dirs.some((dir) => isInside(real, dir))) return `app:${name}`
  if (commands.packages.includes(name)) return `dpkg:${name}`
  const command = closest(commands.names, name)
  if (command != null) return `app:${command}`
  const system_package = closest(commands.packages, name)
  if (system_package != null) return `dpkg:${system_package}`
  return null
}

// The program name closest in length that accounts for a directory name, or null.
function closest(programs: string[], name: string): string | null {
  let best: string | null = null
  for (const program of programs) {
    if (!related(program, name)) continue
    if (best == null || distance(program, name) < distance(best, name)) best = program
  }
  return best
}

// A program accounts for a directory when the two share a first word ("azure-cli" and
// "azure-devops"), when one is the other plus a suffix that starts at a separator ("aws" and
// "aws-cli"), or when the program's name simply continues the directory's ("kubectl" and "kube").
// The reverse is not enough: "script" does not account for a hand-made "scripts".
function related(program: string, name: string): boolean {
  if (program.length < MIN_NAME || name.length < MIN_NAME) return false
  if (program === name) return true
  const first = firstWord(name)
  if (first.length >= MIN_PREFIX && first === firstWord(program)) return true
  const [short, long] = program.length <= name.length ? [program, name] : [name, program]
  if (!long.startsWith(short)) return false
  if (/[-_.]/.test(long.charAt(short.length))) return true
  return short === name && name.length >= MIN_PREFIX
}

function firstWord(name: string): string {
  return name.split(/[-_.]/)[0] ?? ''
}

function distance(command: string, name: string): number {
  return Math.abs(command.length - name.length)
}

async function readCommands(ctx: Context): Promise<Commands> {
  const home_real = await realpath(ctx.home).catch(() => ctx.home)
  const names = new Set<string>()
  const targets: { file: string; command: string }[] = []
  const dirs: string[] = []
  for (const dir of ctx.path_dirs) {
    const dir_real = await realpath(dir).catch(() => null)
    if (dir_real == null || dirs.includes(dir_real)) continue
    dirs.push(dir_real)
    for (const entry of await listDir(dir)) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const command = entry.name.toLowerCase()
      if (command.length >= MIN_NAME) names.add(command)
      const target = entry.isSymbolicLink()
        ? await realpath(join(dir, entry.name)).catch(() => null)
        : join(dir_real, entry.name)
      if (target != null && isInside(home_real, target)) targets.push({ file: target, command: entry.name })
    }
  }
  // Answers 127 where dpkg does not exist: then no system package claims anything.
  const listed = await ctx.run('dpkg-query', ['-W', '-f', '${Package}\\n'])
  const packages = listed.code === 0 ? listed.stdout.split('\n').filter((name) => name.length >= MIN_NAME) : []
  return { names: [...names].sort(), targets, dirs, packages }
}

// The `origin` remote of a checkout, cleaned, or null.
async function originUrl(dir: string): Promise<string | null> {
  const text = await readHead(join(dir, '.git', 'config'))
  let in_origin = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      in_origin = /^\[remote\s+"origin"\]$/.test(line)
      continue
    }
    if (!in_origin) continue
    const match = /^url\s*=\s*(.+)$/.exec(line)
    if (match?.[1] != null) return cleanUrl(match[1].trim())
  }
  return null
}

// Drops whatever can carry a secret: the user and password of "scheme://user:password@host",
// the query string and the fragment. An ssh user without a password ("ssh://git@host",
// "git@host:path") is kept: it is part of the address, not a secret.
export function cleanUrl(value: string): string {
  const url = value.replace(/^(["'])(.*)\1$/, '$2')
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(url)
  if (match == null) return scpUrl(url)
  const [, scheme = '', authority = '', rest = ''] = match
  // The user and password end at the last "@" before the first "/": a password may hold "?" or "#".
  const at = authority.lastIndexOf('@')
  const userinfo = at === -1 ? '' : authority.slice(0, at)
  const keep_user = userinfo !== '' && /ssh/i.test(scheme) && !userinfo.includes(':')
  const host = (keep_user ? authority : authority.slice(at + 1)).replace(/[?#].*$/, '')
  return `${scheme}://${host}${rest.replace(/[?#].*$/, '')}`
}

// "user@host:path", the short ssh form. A user holding a password ("user:token@host:path") is dropped.
function scpUrl(url: string): string {
  const at = url.indexOf('@')
  if (at === -1) return url
  const userinfo = url.slice(0, at)
  if (userinfo.includes('/') || !userinfo.includes(':')) return url
  return url.slice(at + 1)
}

async function isConfig(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null)
  if (info == null || !info.isFile()) return false
  if (info.size > CONFIG_LIMIT) return false
  if (!(await isReadable(file))) return false
  const head = await readHead(file, CONFIG_LIMIT)
  return !head.includes('\0')
}

async function isSkel(ctx: Context, file: string, name: string): Promise<boolean> {
  const skel_file = join(ctx.skel_dir, name)
  if (!(await exists(skel_file))) return false
  const skel_hash = await hashFile(skel_file).catch(() => null)
  return skel_hash != null && skel_hash === (await hashFile(file))
}

async function isDirectory(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null)
  return info != null && info.isDirectory()
}

async function isChildDir(entry: Dirent, file: string): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  return isDirectory(file)
}

async function isReadable(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function isInside(dir: string, file: string): boolean {
  return file === dir || file.startsWith(`${dir}/`)
}
