import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDir, latestSnapshot, loadNotes, saveNotes, saveSnapshot, stateDir } from '../src/store'
import type { Snapshot } from '../src/types'
import type { Item } from '../src/types'

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

let dir = ''
const script = makeItem({ id: 'script:~/tools/fetch-logs', path: '~/tools/fetch-logs' })
const crowded = makeItem({ id: 'anomaly:~/Downloads', category: 'anomaly', fingerprint: '', detail: '900 entries' })

function snapshot(taken_at: string, items = [script], home = '/fixture/home'): Snapshot {
  return { version: 1, taken_at, home, items }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'untracked-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('directories follow the environment', () => {
  expect(stateDir({ UNTRACKED_STATE_DIR: '/a', XDG_STATE_HOME: '/b' })).toBe('/a')
  expect(stateDir({ XDG_STATE_HOME: '/b' })).toBe('/b/untracked')
  expect(stateDir({})).toEndWith('/.local/state/untracked')
  expect(configDir({ UNTRACKED_CONFIG_DIR: '/a', XDG_CONFIG_HOME: '/b' })).toBe('/a')
  expect(configDir({ XDG_CONFIG_HOME: '/b' })).toBe('/b/untracked')
  expect(configDir({})).toEndWith('/.config/untracked')
})

test('a snapshot round trip', async () => {
  const saved = snapshot('2026-01-02T03:04:05.006Z')
  expect(await saveSnapshot(dir, saved)).toBe(true)
  expect(await latestSnapshot(dir, saved.home)).toEqual(saved)
  expect(await readdir(join(dir, 'snapshots'))).toEqual(['2026-01-02T03-04-05.006Z.json'])
})

test('no snapshot gives null', async () => {
  expect(await latestSnapshot(dir, '/fixture/home')).toBeNull()
})

test('nothing changed writes no second file', async () => {
  await saveSnapshot(dir, snapshot('2026-01-02T00:00:00.000Z'))
  expect(await saveSnapshot(dir, snapshot('2026-01-03T00:00:00.000Z'))).toBe(false)
  expect(await readdir(join(dir, 'snapshots'))).toHaveLength(1)
})

test('anomalies do not trigger a save', async () => {
  await saveSnapshot(dir, snapshot('2026-01-02T00:00:00.000Z', [script, crowded]))
  const later = snapshot('2026-01-03T00:00:00.000Z', [script, { ...crowded, detail: '950 entries' }])
  expect(await saveSnapshot(dir, later)).toBe(false)
  expect(await saveSnapshot(dir, snapshot('2026-01-04T00:00:00.000Z', [script]))).toBe(false)
})

test('a change writes a new file, and the latest wins', async () => {
  await saveSnapshot(dir, snapshot('2026-01-02T00:00:00.000Z'))
  const edited = snapshot('2026-01-03T00:00:00.000Z', [{ ...script, fingerprint: 'bbbb' }])
  expect(await saveSnapshot(dir, edited)).toBe(true)
  expect(await latestSnapshot(dir, '/fixture/home')).toEqual(edited)
})

test('two saves in the same millisecond keep both files', async () => {
  await saveSnapshot(dir, snapshot('2026-01-02T00:00:00.000Z'))
  const second = snapshot('2026-01-02T00:00:00.000Z', [])
  await saveSnapshot(dir, second)
  expect(await readdir(join(dir, 'snapshots'))).toHaveLength(2)
  expect(await latestSnapshot(dir, '/fixture/home')).toEqual(second)
})

test('snapshots of another home are ignored', async () => {
  await saveSnapshot(dir, snapshot('2026-01-02T00:00:00.000Z'))
  const other = snapshot('2026-01-03T00:00:00.000Z', [], '/fixture/other')
  expect(await saveSnapshot(dir, other)).toBe(true)
  expect(await latestSnapshot(dir, '/fixture/home')).toEqual(snapshot('2026-01-02T00:00:00.000Z'))
  expect(await saveSnapshot(dir, snapshot('2026-01-04T00:00:00.000Z'))).toBe(false)
  expect(await latestSnapshot(dir, '/fixture/missing')).toBeNull()
})

test('files are private to the owner', async () => {
  const state = join(dir, 'state')
  const config = join(dir, 'config')
  await saveSnapshot(state, snapshot('2026-01-02T00:00:00.000Z'))
  await saveNotes(config, { [script.id]: 'copied from the old laptop' })
  expect((await stat(state)).mode & 0o777).toBe(0o700)
  expect((await stat(join(state, 'snapshots'))).mode & 0o777).toBe(0o700)
  const [file] = await readdir(join(state, 'snapshots'))
  expect((await stat(join(state, 'snapshots', file!))).mode & 0o777).toBe(0o600)
  expect((await stat(config)).mode & 0o777).toBe(0o700)
  expect((await stat(join(config, 'notes.json'))).mode & 0o777).toBe(0o600)
})

test('notes are added and removed', async () => {
  expect(await loadNotes(dir)).toEqual({})
  await saveNotes(dir, { [script.id]: 'needs the acme token' })
  expect(await loadNotes(dir)).toEqual({ [script.id]: 'needs the acme token' })
  await saveNotes(dir, {})
  expect(await loadNotes(dir)).toEqual({})
  expect(await readdir(dir)).toEqual(['notes.json'])
})

test('a snapshot file cut short is skipped, and an empty notes file is no notes', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await saveSnapshot(dir, { version: 1, taken_at: '2026-01-01T00:00:00.000Z', home: '/home/dev', items: [script] })
  await writeFile(join(dir, 'snapshots', '2026-02-01T00-00-00.000Z.json'), '{"version": 1, "items": [')
  expect((await latestSnapshot(dir, '/home/dev'))?.taken_at).toBe('2026-01-01T00:00:00.000Z')
  const notes_dir = join(dir, 'config')
  await mkdir(notes_dir, { recursive: true })
  await writeFile(join(notes_dir, 'notes.json'), '')
  expect(await loadNotes(notes_dir)).toEqual({})
  await writeFile(join(notes_dir, 'notes.json'), '{"a": ')
  expect(loadNotes(notes_dir)).rejects.toThrow('is not valid JSON')
})
