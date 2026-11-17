import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fromRoot, hashText, listDir, readHead, tilde } from '../lib/fs'
import type { Context, Item } from '../types'

export const UNIT_SUFFIXES = ['.service', '.timer', '.socket', '.path']
// A path segment that is a version: "/2.1.326", "/v22.3.0", "/0.1.11-nightly.20260101".
const VERSION_PART = /\/v?\d+(\.\d+)+[^/\s"']*/g
const ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s"'\\])*\s+)*/
// A program word that can be checked and shown: no shell syntax, quotes or assignments.
const PLAIN = /^[^\s=;&|()$`{}<>"'*?]+$/
// Shell builtins a cron command often starts with: not programs that can be missing.
const BUILTINS = new Set(['cd', 'test', '[', 'true', 'false', 'echo', 'exec', 'source', '.', 'export', 'set', 'eval'])

export async function collectServices(ctx: Context): Promise<Item[]> {
  const [units, jobs] = await Promise.all([collectUnits(ctx), collectCron(ctx)])
  return [...units, ...jobs]
}

async function collectUnits(ctx: Context): Promise<Item[]> {
  const dir = join(ctx.home, '.config/systemd/user')
  const entries = await listDir(dir)
  const enabled = await enabledUnits(dir)
  const units = entries.filter(
    (entry) => (entry.isFile() || entry.isSymbolicLink()) && UNIT_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)),
  )
  return Promise.all(units.map((entry) => unitItem(ctx, join(dir, entry.name), enabled.has(entry.name))))
}

// The unit names linked from the "*.wants" folders of a systemd directory.
export async function enabledUnits(dir: string): Promise<Set<string>> {
  const enabled = new Set<string>()
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory() || !entry.name.endsWith('.wants')) continue
    for (const wanted of await listDir(join(dir, entry.name))) enabled.add(wanted.name)
  }
  return enabled
}

// One unit file as an item. A system unit lives below `ctx.root`, keeps its path in the id
// and starts at boot; a user unit starts at login.
export async function unitItem(ctx: Context, file: string, enabled: boolean, system = false): Promise<Item> {
  const name = basename(file)
  const root = system ? (ctx.root ?? '/') : '/'
  const path = system ? fromRoot(root, file) : tilde(ctx.home, file)
  const item: Item = {
    id: system ? `service:${path}` : `service:${name}`,
    kind: 'service',
    category: 'manual',
    name,
    detail: '',
    path,
    fingerprint: '',
  }
  if (!(await present(file))) {
    item.category = 'orphan'
    item.detail = 'links to a unit file which is missing'
    return item
  }

  const text = await readHead(file)
  // An installer rewrites the version in a unit's paths on every update, and enabling a unit
  // changes no file: the fingerprint follows the unit's text without versions, plus its state.
  const fingerprint = hashText(`${text.replace(VERSION_PART, '/*')}\n${enabled}`)
  const command = execStart(joinLines(text))
  if (command == null) {
    item.detail = `${triggerText(name, text)}, ${enabled ? 'enabled' : 'not enabled'}`
    item.fingerprint = fingerprint
    return item
  }

  const program = firstToken(command.replace(/^[-@:+!]+/, '')).replaceAll('%h', ctx.home)
  const shown = tilde(ctx.home, program)
  // A program still holding a specifier or a variable cannot be proven missing.
  const checkable = !/[%$]/.test(program)
  const on_disk = program.startsWith('/') ? join(root, program) : program
  if (checkable && !(await found(ctx, on_disk))) {
    item.category = 'orphan'
    item.detail = `starts ${shown}, which is missing`
    return item
  }
  const moment = system ? 'at boot' : 'at login'
  item.detail = enabled ? `starts ${shown} ${moment}` : `starts ${shown}, not enabled`
  item.fingerprint = fingerprint
  return item
}

// The command line of the first non-empty ExecStart in [Service].
function execStart(text: string): string | null {
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      section = line
      continue
    }
    if (section !== '[Service]') continue
    const value = /^ExecStart\s*=\s*(.*)$/.exec(line)?.[1]?.trim()
    if (value) return value
  }
  return null
}

// A trailing backslash continues a unit line on the next one.
function joinLines(text: string): string {
  return text.replace(/\\\n/g, ' ')
}

function triggerText(name: string, text: string): string {
  const target = /^\s*Unit\s*=\s*(\S+)/m.exec(text)?.[1] ?? name.replace(/\.[^.]+$/, '.service')
  if (name.endsWith('.timer')) return `runs ${target} on a timer`
  if (name.endsWith('.socket')) return `starts ${target} when a connection arrives`
  if (name.endsWith('.path')) return `starts ${target} when a watched path changes`
  return 'a service with no program to start'
}

async function collectCron(ctx: Context): Promise<Item[]> {
  const result = await ctx.run('crontab', ['-l'])
  if (result.code !== 0) return []
  // A repeated line is one job: the same hash would give two items the same id.
  const lines = new Set(result.stdout.split('\n').map((line) => line.trim()))
  const items: Item[] = []
  for (const line of lines) {
    const job = parseJob(line)
    if (job == null) continue
    items.push(await cronItem(ctx, line, job))
  }
  return items
}

type Job = { schedule: string; command: string }

function parseJob(line: string): Job | null {
  if (line === '' || line.startsWith('#')) return null
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return null
  const special = /^(@\w+)\s+(.+)$/.exec(line)
  if (special?.[1] != null && special[2] != null) return { schedule: special[1], command: special[2] }
  const fields = /^((?:\S+\s+){4}\S+)\s+(.+)$/.exec(line)
  if (fields?.[1] == null || fields[2] == null) return null
  return { schedule: fields[1].replace(/\s+/g, ' '), command: fields[2] }
}

async function cronItem(ctx: Context, line: string, job: Job): Promise<Item> {
  const hash = hashText(line)
  const when = job.schedule === '@reboot' ? 'at startup' : `on schedule ${job.schedule}`
  const item: Item = {
    id: `cron:${hash}`,
    kind: 'cron',
    category: 'manual',
    name: 'shell command',
    detail: `runs a shell command ${when}`,
    fingerprint: hash,
  }
  const program = cronProgram(ctx.home, job.command)
  if (!PLAIN.test(program)) return item
  item.name = basename(program)
  item.detail = `runs ${tilde(ctx.home, program)} ${when}`
  if (BUILTINS.has(program) || (await found(ctx, program))) return item
  item.category = 'orphan'
  item.detail = `${item.detail}, which is missing`
  return item
}

// Leading NAME=value assignments are skipped and an unescaped "%" ends the command, as cron does.
function cronProgram(home: string, command: string): string {
  const head = command.split(/(?<!\\)%/)[0] ?? ''
  const program = firstToken(head.trim().replace(ASSIGNMENTS, ''))
  if (program.startsWith('~/')) return join(home, program.slice(2))
  if (program.startsWith('$HOME/')) return join(home, program.slice(6))
  if (program.startsWith('${HOME}/')) return join(home, program.slice(8))
  // cron runs jobs from the home directory.
  if (program.includes('/') && !program.startsWith('/')) return join(home, program)
  return program
}

function firstToken(command: string): string {
  const text = command.trim()
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    const quoted = end === -1 ? text.slice(1) : text.slice(1, end)
    // Arguments inside the quotes are still arguments: they are never shown.
    return quoted.trim().split(/\s+/)[0] ?? ''
  }
  return text.split(/\s+/)[0] ?? ''
}

async function found(ctx: Context, program: string): Promise<boolean> {
  if (program === '') return false
  if (program.startsWith('/')) return present(program)
  return (await ctx.which(program)) != null
}

// True when the file exists, following symlinks.
async function present(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
