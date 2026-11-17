import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as real_scan from '../src/scan'
import type { Item } from '../src/types'
import { type Fixture, makeHome } from './fixture'

// Builds an item for tests. Only the fields a test cares about need to be given.
function makeItem(fields: Partial<Item> & { id: string }): Item {
  const [kind, key] = fields.id.split(/:(.*)/s) as [Item['kind'], string]
  const item: Item = {
    kind,
    category: 'manual',
    name: key.split('/').pop() ?? key,
    detail: 'Written by hand.',
    fingerprint: 'aaaa',
    ...fields,
  }
  return item
}

// The collectors are tested on their own. Here `scan` returns a hand-built list when a test sets one.
const scan_real = real_scan.scan
let fake_items: Item[] | null = null
mock.module('../src/scan', () => ({
  ...real_scan,
  scan: (...args: Parameters<typeof scan_real>) => (fake_items == null ? scan_real(...args) : Promise.resolve(fake_items)),
}))
const { main } = await import('../src/main')

let fixture: Fixture
let untracked_dir = ''
let env: NodeJS.ProcessEnv = {}
let stdout: string[] = []
let stderr: string[] = []

const script = makeItem({ id: 'script:~/tools/fetch-logs', path: '~/tools/fetch-logs', detail: 'Script you wrote.' })
const unit = makeItem({ id: 'service:fetch-logs.service', name: 'fetch-logs', path: '~/tools/fetch-logs', detail: 'Runs it.' })
const pkg = makeItem({
  id: 'package:npm:acme-cli',
  name: 'acme-cli',
  category: 'managed',
  origin: 'npm:acme-cli',
  fingerprint: '',
  detail: 'npm package.',
})

beforeEach(async () => {
  fixture = await makeHome({ 'tools/fetch-logs': { text: '#!/bin/sh\necho logs\n', exec: true } }, { path: ['~/tools'] })
  // Outside the fixture home, so the state never shows up in a scan.
  untracked_dir = await mkdtemp(join(tmpdir(), 'untracked-main-'))
  env = { UNTRACKED_STATE_DIR: join(untracked_dir, 'state'), UNTRACKED_CONFIG_DIR: join(untracked_dir, 'config') }
  stdout = []
  stderr = []
  fake_items = [script, pkg]
})

afterEach(async () => {
  await fixture.cleanup()
  await rm(untracked_dir, { recursive: true, force: true })
})

afterAll(() => {
  fake_items = null
  mock.restore()
})

function untracked(...args: string[]): Promise<number> {
  return main(args, fixture.ctx, { out: (text) => stdout.push(text), err: (text) => stderr.push(text), color: false }, env)
}

function printed(): string {
  return stdout.join('\n')
}

test('scan prints the inventory and saves a snapshot', async () => {
  expect(await untracked('scan')).toBe(0)
  expect(printed()).toContain('Put there by hand')
  expect(printed()).toContain('Not shown: 1 from a package manager. Use --all to list them.')
  expect(stdout.at(-1)).toBe('Snapshot saved.')
  expect(await readdir(join(untracked_dir, 'state', 'snapshots'))).toHaveLength(1)
})

test('a second scan of an unchanged home saves nothing, and diff says nothing changed', async () => {
  await untracked('scan')
  stdout = []
  expect(await untracked('scan')).toBe(0)
  expect(stdout.at(-1)).toBe('Nothing changed since the last snapshot.')
  stdout = []
  expect(await untracked('diff')).toBe(0)
  expect(printed()).toStartWith('Nothing changed since ')
  expect(await readdir(join(untracked_dir, 'state', 'snapshots'))).toHaveLength(1)
})

test('scan then diff with the real collectors on an unchanged fixture', async () => {
  fake_items = null
  expect(await untracked('scan')).toBe(0)
  stdout = []
  expect(await untracked('diff')).toBe(0)
  expect(printed()).toStartWith('Nothing changed since ')
})

test("untracked's own directories inside the scanned home do not show up as changes", async () => {
  fake_items = null
  env = { UNTRACKED_STATE_DIR: fixture.place('~/.local/state/untracked'), UNTRACKED_CONFIG_DIR: fixture.place('~/.config/untracked') }
  expect(await untracked('note', '~/tools/fetch-logs', 'needs the acme token')).toBe(0)
  expect(await untracked('scan')).toBe(0)
  stdout = []
  expect(await untracked('scan')).toBe(0)
  expect(stdout.at(-1)).toBe('Nothing changed since the last snapshot.')
  stdout = []
  expect(await untracked('diff')).toBe(0)
  expect(printed()).toStartWith('Nothing changed since ')
})

test('diff shows what changed and saves nothing', async () => {
  await untracked('scan')
  fake_items = [{ ...script, fingerprint: 'edited' }]
  stdout = []
  expect(await untracked('diff')).toBe(0)
  expect(printed()).toContain('~ Scripts  ~/tools/fetch-logs')
  expect(printed()).toContain('- Packages  acme-cli')
  expect(await readdir(join(untracked_dir, 'state', 'snapshots'))).toHaveLength(1)
})

test('diff without a snapshot says to scan first', async () => {
  expect(await untracked('diff')).toBe(1)
  expect(stderr).toEqual(['No snapshot yet. Run `untracked scan` first.'])
})

test('scan --no-save writes nothing', async () => {
  expect(await untracked('scan', '--no-save')).toBe(0)
  expect(printed()).not.toContain('Snapshot')
  expect(await readdir(untracked_dir)).toEqual([])
})

test('scan --all lists packages', async () => {
  await untracked('scan', '--all', '--no-save')
  expect(printed()).toContain('From a package manager (1)\n  Packages  npm: acme-cli')
  expect(printed()).not.toContain('Not shown')
})

test('scan --json and diff --json print valid JSON', async () => {
  expect(await untracked('note', '~/tools/fetch-logs', 'from', 'the', 'old', 'laptop')).toBe(0)
  stdout = []
  expect(await untracked('scan', '--json')).toBe(0)
  const items = JSON.parse(printed())
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({ id: script.id, note: 'from the old laptop' })
  expect(stderr).toEqual(['Snapshot saved.'])
  stdout = []
  expect(await untracked('diff', '--json')).toBe(0)
  expect(JSON.parse(printed())).toMatchObject({ changes: [] })
})

test('note resolves a path, written with ~ or in full', async () => {
  fake_items = [script, pkg]
  expect(await untracked('note', '~/tools/fetch-logs', 'needs the acme token')).toBe(0)
  expect(stdout).toEqual([`Note saved on ${script.id}.`])
  const notes = JSON.parse(await readFile(join(untracked_dir, 'config', 'notes.json'), 'utf8'))
  expect(notes).toEqual({ [script.id]: 'needs the acme token' })
  expect(await untracked('note', fixture.place('~/tools/fetch-logs'), 'renamed')).toBe(0)
  expect(await untracked('note', pkg.id, 'used by the deploy job')).toBe(0)
  stdout = []
  await untracked('scan', '--no-save', '--all')
  expect(printed()).toContain('      note: renamed')
  expect(printed()).toContain('      note: used by the deploy job')
})

test('note --remove deletes the note', async () => {
  await untracked('note', script.id, 'temporary')
  expect(await untracked('note', '~/tools/fetch-logs', '--remove')).toBe(0)
  expect(stdout.at(-1)).toBe(`Note removed from ${script.id}.`)
  expect(JSON.parse(await readFile(join(untracked_dir, 'config', 'notes.json'), 'utf8'))).toEqual({})
})

test('note on a removed item can still be removed by id', async () => {
  await untracked('note', script.id, 'temporary')
  fake_items = []
  expect(await untracked('note', script.id, '--remove')).toBe(0)
})

test('an ambiguous note target exits 2 and lists the ids', async () => {
  fake_items = [script, unit]
  expect(await untracked('note', '~/tools/fetch-logs', 'text')).toBe(2)
  expect(stderr.join('\n')).toContain('matches 2 items')
  expect(stderr.join('\n')).toContain(unit.id)
})

test('an unknown note target exits 2', async () => {
  expect(await untracked('note', '~/tools/missing', 'text')).toBe(2)
  expect(stderr[0]).toContain('no item has the id or path')
})

test('note without text or with both text and --remove exits 2', async () => {
  expect(await untracked('note', script.id)).toBe(2)
  expect(await untracked('note', script.id, 'text', '--remove')).toBe(2)
  expect(await untracked('note')).toBe(2)
})

test('export prints Markdown or writes it to a file', async () => {
  expect(await untracked('export')).toBe(0)
  expect(printed()).toStartWith('# Machine inventory')
  expect(printed()).not.toContain('## Rebuild')
  expect(printed()).not.toContain(fixture.home)
  stdout = []
  const file = join(untracked_dir, 'inventory.md')
  expect(await untracked('export', '--out', file)).toBe(0)
  expect(await readFile(file, 'utf8')).toStartWith('# Machine inventory')
})

test('--home scans another directory', async () => {
  expect(await untracked('scan', '--home', fixture.place('~/tools'))).toBe(0)
  const [file] = await readdir(join(untracked_dir, 'state', 'snapshots'))
  const snapshot = JSON.parse(await readFile(join(untracked_dir, 'state', 'snapshots', file!), 'utf8'))
  expect(snapshot.home).toBe(fixture.place('~/tools'))
  expect(await untracked('scan', '--home', fixture.place('~/missing'))).toBe(2)
})

test('help, version, unknown commands and options', async () => {
  expect(await untracked('--help')).toBe(0)
  expect(printed()).toContain('untracked scan')
  stdout = []
  expect(await untracked('--version')).toBe(0)
  expect(stdout).toEqual(['0.1.0'])
  expect(await untracked('frobnicate')).toBe(2)
  expect(stderr.join('\n')).toContain('unknown command "frobnicate"')
  expect(stderr.join('\n')).toContain('Usage:')
  expect(await untracked()).toBe(2)
  expect(await untracked('scan', '--colour')).toBe(2)
})
