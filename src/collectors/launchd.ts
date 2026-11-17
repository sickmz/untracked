import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fromRoot, hashFile, hashText, listDir, readHead, tilde } from '../lib/fs'
import { brewOwner } from '../provenance'
import type { Context, Item } from '../types'

// The folders macOS reads launchd jobs from, besides the user's own ~/Library/LaunchAgents.
// Apple's own jobs live in /System/Library and are not read.
const SYSTEM_DIRS = ['Library/LaunchAgents', 'Library/LaunchDaemons']
const ENTRY_LIMIT = 200
// A path segment that is a version: "/2.1.326", "/v22.3.0".
const VERSION_PART = /\/v?\d+(\.\d+)+[^/\s<"']*/g
const BREW_LABEL = /^homebrew\.mxcl\.(.+)$/
// A program word that can be checked and shown: no shell syntax, quotes or assignments.
const PLAIN = /^[^\s=;&|()$`{}<>"'*?]+$/

type Job = { file: string; system: boolean; moment: string }

// launchd jobs on macOS: what starts at login or at boot, and what it starts.
export async function collectLaunchd(ctx: Context): Promise<Item[]> {
  const jobs: Job[] = (await plists(join(ctx.home, 'Library/LaunchAgents'))).map((file) => ({
    file,
    system: false,
    moment: 'at login',
  }))
  if (ctx.root != null) {
    for (const dir of SYSTEM_DIRS) {
      const moment = dir.endsWith('Daemons') ? 'at boot' : 'at login'
      for (const file of await plists(join(ctx.root, dir))) jobs.push({ file, system: true, moment })
    }
  }
  return Promise.all(jobs.map((job) => jobItem(ctx, job)))
}

async function plists(dir: string): Promise<string[]> {
  return (await listDir(dir))
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.plist'))
    .map((entry) => join(dir, entry.name))
    .sort()
    .slice(0, ENTRY_LIMIT)
}

async function jobItem(ctx: Context, job: Job): Promise<Item> {
  const name = basename(job.file)
  const path = job.system ? fromRoot(ctx.root ?? '/', job.file) : tilde(ctx.home, job.file)
  const item: Item = {
    id: job.system ? `service:${path}` : `service:${name}`,
    kind: 'service',
    category: 'manual',
    name,
    detail: '',
    path,
    fingerprint: '',
  }
  if (!(await present(job.file))) {
    item.category = 'orphan'
    item.detail = 'links to a job file which is missing'
    return item
  }

  const text = await readHead(job.file)
  // A binary property list cannot be read without running a tool: it is listed by name and hash.
  if (text.startsWith('bplist')) {
    item.detail = 'binary property list'
    item.fingerprint = await hashFile(job.file)
    return item
  }

  const formula = BREW_LABEL.exec(plistString(text, 'Label') ?? '')?.[1]
  if (formula != null) {
    item.category = 'managed'
    item.origin = `brew:${formula}`
    item.detail = `Homebrew service ${formula}`
    return item
  }

  const disabled = /<key>\s*Disabled\s*<\/key>\s*<true\s*\/>/.test(text)
  const program = plistString(text, 'Program') ?? firstArgument(text)
  if (program == null) {
    item.detail = disabled ? 'no program to start, disabled' : 'no program to start'
    item.fingerprint = hashText(text)
    return item
  }

  // A program word that is not a plain name or path could hold anything: it is never shown.
  if (!PLAIN.test(program)) {
    item.detail = disabled ? 'starts a command, disabled' : `starts a command ${job.moment}`
    item.fingerprint = hashText(`${text.replace(VERSION_PART, '/*')}\n${disabled}`)
    return item
  }
  const shown = tilde(ctx.home, program)
  if (!(await found(ctx, program))) {
    item.category = 'orphan'
    item.detail = `starts ${shown}, which is missing`
    return item
  }

  const owner = brewOwner(program)
  if (owner != null) {
    item.category = 'managed'
    item.origin = `brew:${owner}`
    item.detail = `Homebrew formula ${owner}`
    return item
  }

  const app = appName(program)
  if (app != null) {
    item.category = 'installed'
    item.origin = `app:${app}`
    item.detail = `part of ${app}.app`
    return item
  }

  item.detail = disabled ? `starts ${shown}, disabled` : `starts ${shown} ${job.moment}`
  // An updater rewrites versions in paths: the fingerprint follows the job without them.
  item.fingerprint = hashText(`${text.replace(VERSION_PART, '/*')}\n${disabled}`)
  return item
}

// The string right after <key>name</key> in an XML property list.
function plistString(text: string, key: string): string | null {
  const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`).exec(text)
  return match?.[1] == null ? null : decode(match[1].trim())
}

// The first string of ProgramArguments: the program. The other arguments are never read.
function firstArgument(text: string): string | null {
  const match = /<key>\s*ProgramArguments\s*<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)
  return match?.[1] == null ? null : decode(match[1].trim())
}

function decode(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

// "Acme" in "/Applications/Acme.app/Contents/MacOS/acme-helper".
function appName(program: string): string | null {
  const bundle = program.split('/').find((segment) => segment.endsWith('.app'))
  return bundle == null ? null : bundle.slice(0, -4)
}

async function found(ctx: Context, program: string): Promise<boolean> {
  if (program === '') return false
  if (!program.startsWith('/')) return (await ctx.which(program)) != null
  // A system path is looked up below the system root; a path in the home as it is.
  if (program === ctx.home || program.startsWith(`${ctx.home}/`)) return present(program)
  return present(join(ctx.root ?? '/', program))
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
