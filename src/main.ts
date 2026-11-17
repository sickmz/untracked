#!/usr/bin/env bun
import { stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import package_json from '../package.json'
import { createContext } from './context'
import { compare } from './diff'
import { tilde } from './lib/fs'
import { renderMarkdown } from './render/markdown'
import { renderDiff, renderScan } from './render/text'
import { scan } from './scan'
import { configDir, latestSnapshot, loadNotes, saveNotes, saveSnapshot, stateDir } from './store'
import type { Context, Item } from './types'

export type Output = {
  out(text: string): void
  err(text: string): void
  color: boolean
  // Terminal width. Lines are printed in full when it is left out.
  width?: number
}

const USAGE = `untracked lists what was put by hand on this machine, and what changed since the last look.

Usage:
  untracked scan [--all] [--json] [--no-save] [--home DIR]
      Print the inventory and save a snapshot.
  untracked diff [--json] [--home DIR]
      Compare the home as it is now with the latest snapshot.
  untracked export [--out FILE] [--home DIR]
      Write the inventory as Markdown.
  untracked note <id-or-path> <text>
  untracked note <id-or-path> --remove
      Attach a note to an item, or remove it.

Options:
  --all        Also list what an installer or a package manager put there.
  --json       Print JSON instead of text.
  --no-save    Do not save a snapshot.
  --home DIR   Scan DIR instead of your home directory.
  --out FILE   Write the Markdown to FILE instead of the terminal.
  --help       Show this help.
  --version    Show the version.`

const HOME_OPTION = { home: { type: 'string' } } as const
const OPTIONS = {
  scan: { ...HOME_OPTION, all: { type: 'boolean' }, json: { type: 'boolean' }, 'no-save': { type: 'boolean' } },
  diff: { ...HOME_OPTION, json: { type: 'boolean' } },
  export: { ...HOME_OPTION, out: { type: 'string' } },
  note: { remove: { type: 'boolean' } },
} as const

class UsageError extends Error {}

// Runs one command and returns the exit code.
export async function main(
  args: string[],
  ctx: Context,
  output: Output,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, ...rest] = args
  if (command === '--help' || command === '-h' || command === 'help') {
    output.out(USAGE)
    return 0
  }
  if (command === '--version' || command === '-v') {
    output.out(package_json.version)
    return 0
  }
  try {
    if (command === 'scan') return await runScan(rest, ctx, output, env)
    if (command === 'diff') return await runDiff(rest, ctx, output, env)
    if (command === 'export') return await runExport(rest, ctx, output, env)
    if (command === 'note') return await runNote(rest, ctx, output, env)
  } catch (error) {
    if (!(error instanceof UsageError) && !badArgs(error)) throw error
    output.err(`untracked: ${(error as Error).message}`)
    output.err('Run `untracked --help` to see the commands.')
    return 2
  }
  if (command != null) output.err(`untracked: unknown command "${command}".\n`)
  output.err(USAGE)
  return 2
}

async function runScan(args: string[], ctx: Context, output: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({ args, options: OPTIONS.scan, strict: true })
  const home_ctx = await withHome(ctx, values.home)
  const items = await scan(home_ctx, true)
  const notes = await loadNotes(configDir(env))
  if (values.json) output.out(JSON.stringify(withNotes(items, notes), null, 2))
  else output.out(renderScan(items, notes, values.all === true, output.color, output.width))
  if (values['no-save']) return 0
  const snapshot = { version: 1, taken_at: new Date().toISOString(), home: home_ctx.home, items } as const
  const saved = await saveSnapshot(stateDir(env), snapshot)
  const message = saved ? 'Snapshot saved.' : 'Nothing changed since the last snapshot.'
  // With --json the message goes to stderr so stdout stays valid JSON.
  if (values.json) output.err(message)
  else output.out(message)
  return 0
}

async function runDiff(args: string[], ctx: Context, output: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({ args, options: OPTIONS.diff, strict: true })
  const home_ctx = await withHome(ctx, values.home)
  const latest = await latestSnapshot(stateDir(env), home_ctx.home)
  if (latest == null) {
    output.err('No snapshot yet. Run `untracked scan` first.')
    return 1
  }
  const changes = compare(latest.items, await scan(home_ctx))
  if (values.json) output.out(JSON.stringify({ since: latest.taken_at, changes }, null, 2))
  else output.out(renderDiff(changes, latest.taken_at, output.color, output.width))
  return 0
}

async function runExport(args: string[], ctx: Context, output: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({ args, options: OPTIONS.export, strict: true })
  const home_ctx = await withHome(ctx, values.home)
  const items = await scan(home_ctx, true)
  const notes = await loadNotes(configDir(env))
  const markdown = renderMarkdown(items, notes, new Date().toISOString().slice(0, 10))
  if (values.out == null) {
    output.out(markdown.trimEnd())
    return 0
  }
  await writeFile(values.out, markdown, { mode: 0o600 })
  output.out(`Inventory written to ${values.out}.`)
  return 0
}

async function runNote(args: string[], ctx: Context, output: Output, env: NodeJS.ProcessEnv): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: OPTIONS.note, strict: true, allowPositionals: true })
  const [target, ...words] = positionals
  const text = words.join(' ').trim()
  if (target == null) throw new UsageError('say which item the note is for.')
  if (values.remove && text !== '') throw new UsageError('use either a note text or --remove, not both.')
  if (!values.remove && text === '') throw new UsageError('the note text is missing.')
  const dir = configDir(env)
  const notes = await loadNotes(dir)
  // A note can be removed by id even when its item is gone.
  const id = values.remove && notes[target] != null ? target : findItem(await scan(ctx), ctx.home, target, output)
  if (id == null) return 2
  const updated = { ...notes }
  if (values.remove) {
    if (updated[id] == null) {
      output.out(`${id} has no note.`)
      return 0
    }
    delete updated[id]
    await saveNotes(dir, updated)
    output.out(`Note removed from ${id}.`)
    return 0
  }
  updated[id] = text
  await saveNotes(dir, updated)
  output.out(`Note saved on ${id}.`)
  return 0
}

// The id of the one item whose id or path is `target`, or null after explaining the problem.
function findItem(items: Item[], home: string, target: string, output: Output): string | null {
  const by_id = items.find((item) => item.id === target)
  if (by_id != null) return by_id.id
  const path = tilde(home, target.startsWith('/') ? resolve(target) : target.replace(/\/+$/, ''))
  const matches = items.filter((item) => item.path === path)
  if (matches.length === 1) return matches[0]!.id
  if (matches.length === 0) {
    output.err(`untracked: no item has the id or path "${target}".`)
    output.err('Use a path shown by `untracked scan --all`, or an id from `untracked scan --json`.')
    return null
  }
  output.err(`untracked: "${target}" matches ${matches.length} items. Use one of these ids:`)
  for (const item of matches) output.err(`  ${item.id}`)
  return null
}

function withNotes(items: Item[], notes: Record<string, string>): (Item & { note?: string })[] {
  return items.map((item) => {
    const note = notes[item.id]
    if (note == null) return item
    return { ...item, note }
  })
}

async function withHome(ctx: Context, dir: string | undefined): Promise<Context> {
  if (dir == null) return ctx
  const home = resolve(dir)
  const info = await stat(home).catch(() => null)
  if (info == null || !info.isDirectory()) throw new UsageError(`${dir} is not a directory.`)
  // Another directory is scanned on its own: the system around it belongs to this machine.
  return { ...ctx, home, root: null }
}

function badArgs(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')
}

if (import.meta.main) {
  const output: Output = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    color: process.stdout.isTTY === true && process.env.NO_COLOR == null,
  }
  if (process.stdout.isTTY === true) output.width = process.stdout.columns
  try {
    process.exitCode = await main(Bun.argv.slice(2), createContext(), output)
  } catch (error) {
    output.err(`untracked: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
