import { afterEach, expect, test } from 'bun:test'
import { scan } from '../src/scan'
import { diskUsage, measure, spaceItems } from '../src/sizes'
import type { Item } from '../src/types'
import { type Fixture, makeHome } from './fixture'

const GB = 1024 ** 3
const KB_PER_GB = 1024 ** 2

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

// du output for the fixture home: sizes in GB, paths written with "~".
function du(home: string, sizes: Record<string, number>): string {
  const lines = Object.entries(sizes).map(([path, gigabytes]) => `${Math.round(gigabytes * KB_PER_GB)}\t${path.replace('~', home)}`)
  return `${lines.join('\n')}\n`
}

function item(fields: Partial<Item> & { id: string; kind: Item['kind'] }): Item {
  return { category: 'manual', name: 'x', detail: '', fingerprint: '', ...fields }
}

test('directories get their size from du, files from the disk, links and other kinds get none', async () => {
  fixture = await makeHome({
    'tools/fetch-logs': { text: 'x'.repeat(5000), exec: true },
    'bin/check': { link: '~/tools/fetch-logs' },
    '.bashrc': 'deploy() { :; }\n',
  })
  const usage = new Map([[fixture.place('~/code'), 3 * GB]])
  const items = await measure(fixture.ctx, usage, [
    item({ id: 'dir:~/code', kind: 'dir', path: '~/code' }),
    item({ id: 'script:~/tools/fetch-logs', kind: 'script', path: '~/tools/fetch-logs' }),
    item({ id: 'script:~/bin/check', kind: 'script', path: '~/bin/check' }),
    item({ id: 'shell_function:deploy', kind: 'shell_function', path: '~/.bashrc' }),
    item({ id: 'dir:/opt/acme', kind: 'dir', path: '/opt/acme' }),
  ])
  const sizes = Object.fromEntries(items.map((entry) => [entry.id, entry.size]))
  expect(sizes['dir:~/code']).toBe(3 * GB)
  expect(sizes['script:~/tools/fetch-logs']).toBeGreaterThanOrEqual(4096)
  expect(sizes['script:~/bin/check']).toBeUndefined()
  expect(sizes['shell_function:deploy']).toBeUndefined()
  expect(sizes['dir:/opt/acme']).toBeUndefined()
})

test('du output is read, and a missing du means no sizes', async () => {
  fixture = await makeHome({})
  expect((await diskUsage(fixture.ctx)).size).toBe(0)
  const ctx = { ...fixture.ctx, run: async () => ({ code: 1, stdout: du(fixture!.home, { '~': 2, '~/code': 1.5 }) }) }
  const usage = await diskUsage(ctx)
  expect(usage.get(fixture.home)).toBe(2 * GB)
  expect(usage.get(fixture.place('~/code'))).toBe(1.5 * GB)
  const slow = { ...fixture.ctx, run: async () => Promise.reject(new Error('du did not answer')) }
  expect((await diskUsage(slow)).size).toBe(0)
})

test('the largest directories are listed, a chain of single children only by its end', () => {
  const home = '/home/dev'
  const usage = new Map(
    Object.entries({
      '/home/dev': 20,
      '/home/dev/code': 10,
      '/home/dev/code/shop': 9.5,
      '/home/dev/code/shop/logs': 6,
      '/home/dev/code/shop/logs/2026': 5.9,
      '/home/dev/.cache': 4,
      '/home/dev/.cache/acme': 2,
      '/home/dev/.cache/orbit': 1.5,
      '/home/dev/notes': 0.5,
    }).map(([path, gigabytes]) => [path, gigabytes * GB]),
  )
  const found = spaceItems(home, usage)
  expect(found.map((entry) => `${entry.name} ${(entry.size ?? 0) / GB}`)).toEqual([
    '~ 20',
    '~/code/shop 9.5',
    '~/code/shop/logs 6',
    '~/.cache 4',
    '~/.cache/acme 2',
    '~/.cache/orbit 1.5',
  ])
  expect(found.every((entry) => entry.category === 'space' && entry.fingerprint === '')).toBe(true)
})

test('scan adds sizes only when asked, and space never counts as a change', async () => {
  fixture = await makeHome({ 'code/notes.txt': 'x' })
  const answer = du(fixture.home, { '~': 3, '~/code': 2 })
  const ctx = { ...fixture.ctx, run: async (cmd: string) => (cmd === 'du' ? { code: 0, stdout: answer } : { code: 127, stdout: '' }) }
  const plain = await scan(ctx)
  const sized = await scan(ctx, true)
  expect(plain.some((entry) => entry.size != null || entry.category === 'space')).toBe(false)
  expect(sized.find((entry) => entry.id === 'dir:~/code')?.size).toBe(2 * GB)
  expect(sized.filter((entry) => entry.category === 'space').map((entry) => entry.id)).toEqual(['space:~', 'space:~/code'])
  const { compare } = await import('../src/diff')
  expect(compare(plain, sized)).toEqual([])
})

test('control characters in a file name are written out, never passed on', async () => {
  fixture = await makeHome({ '.ssh/k\x1b[31mred.pub': 'ssh-ed25519 AAAA dev@laptop\n', 'to\x07ols/run': { text: '#!/bin/sh\n', exec: true } })
  const items = await scan(fixture.ctx)
  const text = items.map((entry) => `${entry.id} ${entry.name} ${entry.path ?? ''} ${entry.detail}`).join('\n')
  expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/)
  expect(items.find((entry) => entry.kind === 'key')?.path).toBe('~/.ssh/k\\x1b[31mred')
})
