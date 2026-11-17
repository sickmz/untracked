import { afterEach, expect, test } from 'bun:test'
import { collectAnomalies, findCrowded, findZombies, type Limits } from '../src/collectors/anomalies'
import type { Item } from '../src/types'
import { type Fixture, makeHome, type Tree } from './fixture'

const LIMITS: Limits = { depth: 8, version_depth: 4, entries: 100_000, ms: 10_000, crowded: 5, versions: 4 }
let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

function files(dir: string, count: number): Tree {
  const tree: Tree = {}
  for (let index = 0; index < count; index++) tree[`${dir}/file-${index}.log`] = ''
  return tree
}

function dirs(dir: string, names: string[]): Tree {
  const tree: Tree = {}
  for (const name of names) tree[`${dir}/${name}`] = { dir: true }
  return tree
}

async function walk(tree: Tree, limits: Limits = LIMITS): Promise<Item[]> {
  fixture = await makeHome(tree, {})
  return findCrowded(fixture.ctx, limits)
}

test('a crowded directory is reported with its entry count', async () => {
  const items = await walk({ ...files('logs/acme', 6), ...files('notes', 3) })
  expect(items).toEqual([
    {
      id: 'anomaly:crowded:~/logs/acme',
      kind: 'anomaly',
      category: 'anomaly',
      name: '~/logs/acme',
      detail: '6 entries',
      path: '~/logs/acme',
      fingerprint: '',
    },
  ])
})

test('.cache, node_modules and .git are not entered', async () => {
  const items = await walk({
    ...files('.cache/acme', 8),
    ...files('app/node_modules/acme', 8),
    ...files('app/.git/objects', 8),
    'app/.git/HEAD': 'ref',
  })
  expect(items).toEqual([])
})

test('~/Library/Caches is not entered, the rest of ~/Library is', async () => {
  const items = await walk({ ...files('Library/Caches/acme', 8), ...files('Library/Logs/acme', 6) })
  expect(items.map((item) => item.id)).toEqual(['anomaly:crowded:~/Library/Logs/acme'])
})

test('a crowded directory inside a git checkout is found', async () => {
  const items = await walk({ 'src/acme-cli/.git/HEAD': 'ref', ...files('src/acme-cli/fixtures', 7) })
  expect(items.map((item) => item.id)).toEqual(['anomaly:crowded:~/src/acme-cli/fixtures'])
})

test('the depth limit is respected', async () => {
  const items = await walk(files('a/b/c', 6), { ...LIMITS, depth: 2 })
  expect(items).toEqual([])
})

test('a walk that hits the entry limit says so once', async () => {
  const tree: Tree = {}
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) Object.assign(tree, files(`projects/${name}`, 3))
  const items = await walk(tree, { ...LIMITS, entries: 6 })
  const stopped = items.filter((item) => item.id === 'anomaly:walk-stopped')
  expect(stopped).toHaveLength(1)
  expect(stopped[0]?.detail).toMatch(/^the scan stopped after \d+ entries, so some directories were not checked$/)
})

test('a walk that finishes adds no stop item', async () => {
  const items = await walk(files('projects/alpha', 3))
  expect(items).toEqual([])
})

test('piled-up versions are reported', async () => {
  const items = await walk({
    ...dirs('.acme-cli/versions', ['1.2.3', '1.3.0', 'v2.0.0', '2.1.0-beta.1']),
    ...dirs('.acme-build', ['tool-0123456789abcdef', 'tool-fedcba9876543210', 'tool-aaaaaaaaaaaa', 'tool-bbbbbbbbbbbb']),
    ...dirs('.acme-few', ['1.0.0', '1.1.0', '1.2.0']),
  })
  expect(items.map((item) => `${item.id} ${item.detail}`).sort()).toEqual([
    'anomaly:versions:~/.acme-build 4 versions kept',
    'anomaly:versions:~/.acme-cli/versions 4 versions kept',
  ])
})

test('session ids and stored hashes are not versions', async () => {
  const items = await walk({
    ...dirs('.acme-store', ['0123456789abcdef0123', 'abcdefabcdefabcdefabcdef', 'ffffffffffffffffffff', '1111111111111111111111']),
    ...dirs('.acme-sessions', [
      '0b8f6f0e-5a1c-4c0e-9a57-0d2f6f3b1a11',
      '1c9a7a1f-6b2d-4d1f-8b68-1e3a7a4c2b22',
      '2d0b8b2a-7c3e-4e2a-9c79-2f4b8b5d3c33',
      'run-3e1c9c3b-8d4f-4f3b-8d80-3a5c9c6e4d44',
    ]),
  })
  expect(items).toEqual([])
})

test('a package cache is not a pile-up', async () => {
  const items = await walk(
    dirs('.acme-pkg/cache', [
      'left-pad@1.2.3',
      'acme@2.0.1-0123456789abcdef',
      'acme@2.0.2-0123456789abcdee',
      'acme@2.0.3-0123456789abcded',
      '1.0.0',
    ]),
    { ...LIMITS, crowded: 100 },
  )
  expect(items).toEqual([])
})

test('version pile-ups deeper than the version depth are not checked', async () => {
  const items = await walk(dirs('a/b/c/d/e/f', ['1.0.0', '1.1.0', '1.2.0', '1.3.0']))
  expect(items).toEqual([])
})

async function proc(tree: Tree): Promise<string> {
  const sys: Tree = {}
  for (const [key, entry] of Object.entries(tree)) sys[`/sys/proc/${key}`] = entry
  fixture = await makeHome({}, { sys })
  return fixture.place('/sys/proc')
}

function zombie(pid: number, ppid: number, command = 'acme-worker'): Tree {
  return { [`${pid}/stat`]: `${pid} (${command}) Z ${ppid} ${pid} ${pid} 0 -1 4194564 0 0` }
}

test('zombies are counted and grouped by parent', async () => {
  const tree: Tree = {
    '100/stat': '100 (acme-server) S 1 100 100 0 -1',
    '100/comm': 'acme-server\n',
    '200/stat': '200 (sync-notes) S 1 200 200 0 -1',
    '200/comm': 'sync-notes\n',
    '300/stat': '300 (sleeper) S 1 300 300 0 -1',
    self: { dir: true },
    'cpuinfo': 'x',
  }
  for (let pid = 1000; pid < 1004; pid++) Object.assign(tree, zombie(pid, 100))
  Object.assign(tree, zombie(1010, 200))
  const proc_dir = await proc(tree)
  expect(await findZombies(proc_dir, 6)).toEqual([])
  expect(await findZombies(proc_dir, 5)).toEqual([
    {
      id: 'anomaly:zombies',
      kind: 'anomaly',
      category: 'anomaly',
      name: 'zombie processes',
      detail: '5 zombie processes, 4 of them children of acme-server (pid 100)',
      fingerprint: '',
    },
  ])
})

test('a command with spaces and parentheses is parsed from the last parenthesis', async () => {
  const tree: Tree = {
    '100/stat': '100 (acme (main) worker) S 1 100 100 0 -1',
    '100/comm': 'acme (main) worker\n',
    // Sleeping, though its name looks like a zombie state.
    '400/stat': '400 (a) Z 7 (b) S 100 400 400 0 -1',
  }
  Object.assign(tree, zombie(500, 100, 'b) Z 9 (c d'), zombie(501, 100, 'x y'), zombie(502, 7))
  const proc_dir = await proc(tree)
  const items = await findZombies(proc_dir, 3)
  expect(items.map((item) => item.detail)).toEqual([
    '3 zombie processes, 2 of them children of acme (main) worker (pid 100)',
  ])
})

test('an unknown parent and a missing /proc are handled', async () => {
  const proc_dir = await proc({ ...zombie(10, 99), ...zombie(11, 99) })
  expect((await findZombies(proc_dir, 2))[0]?.detail).toBe(
    '2 zombie processes, 2 of them children of an unknown process (pid 99)',
  )
  expect(await findZombies(`${proc_dir}/absent`, 1)).toEqual([])
})

test('collectAnomalies on a small home reports at most the zombie item', async () => {
  fixture = await makeHome(files('notes', 3))
  const items = await collectAnomalies(fixture.ctx)
  expect(items.filter((item) => item.id !== 'anomaly:zombies')).toEqual([])
})
