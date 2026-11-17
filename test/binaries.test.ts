import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { WALK_LIMIT, collectBinaries } from '../src/collectors/binaries'
import type { Item } from '../src/types'
import { type Fixture, type Tree, makeHome } from './fixture'

const ELF = '\x7fELF\x02\x01\x01\x00compiled'
const SCRIPT = '#!/bin/sh\necho hello\n'

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

function byId(items: Item[], id: string): Item {
  const item = items.find((candidate) => candidate.id === id)
  if (item == null) throw new Error(`missing ${id}; got ${items.map((candidate) => candidate.id).join(', ')}`)
  return item
}

const RICH: Tree = {
  '.local/bin/backup': { text: SCRIPT, exec: true },
  '.local/bin/acme': { link: '~/.local/share/acme-cli/v2/current/bin/acme' },
  '.local/share/acme-cli/v2/current/bin/acme': { text: ELF, exec: true },
  '.local/bin/wrapped': { text: '#!/bin/sh\nexec "$HOME/.local/share/wrapped/1.4.0/wrapped" "$@"\n', exec: true },
  '.local/share/wrapped/1.4.0/wrapped': { text: ELF, exec: true },
  '.local/bin/check': { link: '~/my-skills/check/bin/check' },
  'my-skills/check/bin/check': { text: SCRIPT, exec: true },
  '.local/bin/gone': { link: '~/x/y' },
  '.local/bin/notes.txt': 'not a program',
  'bin/hello': { text: SCRIPT, exec: true },
  'tools/fetch-logs': { text: ELF, exec: true },
  'tools/readme.md': 'plain text',
  'tools/data.bin': { text: 'no magic here', exec: true },
  'tools/a/b/deep': { text: SCRIPT, exec: true },
  'tools/a/b/c/too-deep': { text: SCRIPT, exec: true },
  'tools/node_modules/x/cli': { text: SCRIPT, exec: true },
  'tools/.hidden/secret-tool': { text: SCRIPT, exec: true },
  'tools/checkout/.git/HEAD': 'ref: refs/heads/main\n',
  'tools/checkout/build.sh': { text: SCRIPT, exec: true },
  'project/.git/HEAD': 'ref: refs/heads/main\n',
  'project/run': { text: SCRIPT, exec: true },
  'setup.sh': { text: SCRIPT, exec: true },
  '.npm-global/bin/acme-lint': { link: '~/.npm-global/lib/node_modules/acme-lint/bin/lint.js' },
  '.npm-global/lib/node_modules/acme-lint/bin/lint.js': { text: '#!/usr/bin/env node\n', exec: true },
  '.local/bin/jq': { link: '/sys/bin/jq' },
}

describe('collectBinaries', () => {
  test('classifies a rich home', async () => {
    fixture = await makeHome(RICH, { path: ['~/.local/bin', '~/.npm-global/bin', '/sys/bin'], sys: { '/sys/bin/jq': { text: ELF, exec: true } } })
    const jq = fixture.place('/sys/bin/jq')
    const ctx = {
      ...fixture.ctx,
      run: async (cmd: string, args: string[]) =>
        cmd === 'dpkg' && args[1] === jq ? { code: 0, stdout: `jq: ${jq}\n` } : { code: 1, stdout: '' },
    }
    const items = await collectBinaries(ctx)

    const ids = items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)

    const backup = byId(items, 'script:~/.local/bin/backup')
    expect(backup.category).toBe('manual')
    expect(backup.fingerprint).not.toBe('')

    expect(byId(items, 'binary:~/.local/bin/jq')).toMatchObject({ category: 'managed', origin: 'dpkg:jq', fingerprint: '' })
    expect(byId(items, 'script:~/.npm-global/bin/acme-lint')).toMatchObject({ category: 'managed', origin: 'npm:acme-lint' })
    expect(byId(items, 'binary:~/.local/bin/acme')).toMatchObject({ category: 'installed', origin: 'installer:acme-cli', fingerprint: '' })
    expect(byId(items, 'script:~/.local/bin/wrapped')).toMatchObject({ category: 'installed', origin: 'installer:wrapped', fingerprint: '' })
    expect(byId(items, 'script:~/.local/bin/check')).toMatchObject({ category: 'manual', path: '~/.local/bin/check' })
    expect(byId(items, 'binary:~/tools/fetch-logs')).toMatchObject({ kind: 'binary', category: 'manual' })
    expect(byId(items, 'script:~/tools/a/b/deep').category).toBe('manual')
    expect(byId(items, 'script:~/setup.sh').category).toBe('manual')
    expect(byId(items, 'script:~/bin/hello').category).toBe('manual')

    const gone = byId(items, 'binary:~/.local/bin/gone')
    expect(gone.category).toBe('orphan')
    expect(gone.detail).toBe('link to ~/x/y, which is missing')
    expect(gone.fingerprint).toBe(fixture.place('~/x/y'))

    for (const skipped of ['notes.txt', 'readme.md', 'data.bin', 'too-deep', 'cli', 'secret-tool', 'build.sh', 'run']) {
      expect(items.some((item) => item.name === skipped)).toBe(false)
    }
    // ~/my-skills/check/bin/check is found twice: through the link and by the walk.
    expect(byId(items, 'script:~/my-skills/check/bin/check').category).toBe('manual')
  })

  test('fingerprints follow content for manual files and stay empty for installed ones', async () => {
    fixture = await makeHome(RICH)
    const first = await collectBinaries(fixture.ctx)
    const again = await collectBinaries(fixture.ctx)
    expect(again).toEqual(first)

    await writeFile(fixture.place('~/.local/bin/backup'), `${SCRIPT}echo more\n`)
    await writeFile(fixture.place('~/.local/share/acme-cli/v2/current/bin/acme'), `${ELF} updated`)
    const changed = await collectBinaries(fixture.ctx)
    expect(byId(changed, 'script:~/.local/bin/backup').fingerprint).not.toBe(byId(first, 'script:~/.local/bin/backup').fingerprint)
    expect(byId(changed, 'binary:~/.local/bin/acme').fingerprint).toBe('')
    expect(byId(changed, 'binary:~/tools/fetch-logs').fingerprint).toBe(byId(first, 'binary:~/tools/fetch-logs').fingerprint)
  })

  test('the walk stops after the entry limit, at the same place every time', async () => {
    const tree: Tree = { 'big/aaa-early': { text: SCRIPT, exec: true }, 'big/zzz-late': { text: SCRIPT, exec: true } }
    for (let index = 0; index < WALK_LIMIT; index += 1) tree[`big/m-${String(index).padStart(5, '0')}`] = 'filler'
    fixture = await makeHome(tree)
    const items = await collectBinaries(fixture.ctx)
    expect(items.map((item) => item.id)).toEqual(['script:~/big/aaa-early'])
  })

  test('a top-level folder that is a git checkout is skipped entirely', async () => {
    fixture = await makeHome({ 'acme-cli/.git/HEAD': 'ref\n', 'acme-cli/dist/acme': { text: ELF, exec: true } })
    expect(await collectBinaries(fixture.ctx)).toEqual([])
  })

  test('a PATH folder inside the home counts any executable, even without magic', async () => {
    fixture = await makeHome({ 'scripts/plain': { text: 'echo hi\n', exec: true } }, { path: ['~/scripts'] })
    expect(byId(await collectBinaries(fixture.ctx), 'script:~/scripts/plain').category).toBe('manual')
  })
})

test('a program that cannot be read is listed instead of stopping the scan', async () => {
  const { chmod } = await import('node:fs/promises')
  fixture = await makeHome({ 'bin/locked': { text: SCRIPT, exec: true } })
  await chmod(fixture.place('~/bin/locked'), 0o111)
  if (process.getuid?.() === 0) return
  const items = await collectBinaries(fixture.ctx)
  expect(byId(items, 'script:~/bin/locked').fingerprint).toBe('unreadable')
})
