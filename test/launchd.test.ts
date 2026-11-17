import { afterEach, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { collectLaunchd } from '../src/collectors/launchd'
import type { Item } from '../src/types'
import { type Fixture, type FixtureOptions, makeHome, type Tree } from './fixture'

const AGENTS = 'Library/LaunchAgents'
const TOKEN = 'tok_0a1b2c3d4e5f6789fake'
let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

async function collect(tree: Tree, options: FixtureOptions = {}): Promise<Item[]> {
  fixture = await makeHome(tree, options)
  return collectLaunchd(fixture.ctx)
}

function find(items: Item[], id: string): Item {
  const item = items.find((candidate) => candidate.id === id)
  if (item == null) throw new Error(`no item ${id}; got ${items.map((candidate) => candidate.id).join(', ')}`)
  return item
}

// An XML property list. `body` goes inside the top-level dict.
function plist(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
}

function job(label: string, program: string, extra = ''): string {
  return plist(
    `  <key>Label</key>\n  <string>${label}</string>\n` +
      `  <key>ProgramArguments</key>\n  <array>\n    <string>${program}</string>\n    <string>--token=${TOKEN}</string>\n  </array>\n${extra}`,
  )
}

test('a user agent starting a hand-made script is manual and starts at login', async () => {
  fixture = await makeHome({ 'tools/sync-notes': { text: '#!/bin/sh\n', exec: true } })
  // launchd needs an absolute path, which is only known once the fixture exists.
  const file = fixture.place(`~/${AGENTS}/local.sync-notes.plist`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, job('local.sync-notes', fixture.place('~/tools/sync-notes')))
  const items = await collectLaunchd(fixture.ctx)
  expect(items).toHaveLength(1)
  const item = find(items, 'service:local.sync-notes.plist')
  expect(item.kind).toBe('service')
  expect(item.category).toBe('manual')
  expect(item.path).toBe(`~/${AGENTS}/local.sync-notes.plist`)
  expect(item.detail).toBe('starts ~/tools/sync-notes at login')
  expect(item.fingerprint).toMatch(/^[0-9a-f]{16}$/)
})

test('arguments after the program are never shown', async () => {
  const items = await collect(
    { [`${AGENTS}/local.fetch.plist`]: job('local.fetch', '/usr/bin/fetch') },
    { sys: { '/sys/usr/bin/fetch': { text: '#!/bin/sh\n', exec: true } } },
  )
  expect(find(items, 'service:local.fetch.plist').detail).toBe('starts /usr/bin/fetch at login')
  expect(JSON.stringify(items)).not.toContain(TOKEN)
})

test('a job whose program is missing was left behind', async () => {
  const items = await collect({ [`${AGENTS}/com.acme.updater.plist`]: job('com.acme.updater', '/opt/acme/updater') })
  const item = find(items, 'service:com.acme.updater.plist')
  expect(item.category).toBe('orphan')
  expect(item.detail).toBe('starts /opt/acme/updater, which is missing')
})

test('a job of an app bundle was installed by the app', async () => {
  const items = await collect(
    {},
    {
      sys: {
        '/sys/Library/LaunchAgents/com.orbit.helper.plist': job('com.orbit.helper', '/Applications/Orbit.app/Contents/MacOS/orbit-helper'),
        '/sys/Applications/Orbit.app/Contents/MacOS/orbit-helper': { text: '\xcf\xfa\xed\xfe', exec: true },
      },
    },
  )
  const item = find(items, 'service:/Library/LaunchAgents/com.orbit.helper.plist')
  expect(item.category).toBe('installed')
  expect(item.origin).toBe('app:Orbit')
  expect(item.detail).toBe('part of Orbit.app')
  expect(item.fingerprint).toBe('')
})

test('a Homebrew service is managed by Homebrew', async () => {
  const items = await collect({
    [`${AGENTS}/homebrew.mxcl.postgresql@16.plist`]: job('homebrew.mxcl.postgresql@16', '/opt/homebrew/opt/postgresql@16/bin/postgres'),
  })
  const item = find(items, 'service:homebrew.mxcl.postgresql@16.plist')
  expect(item.category).toBe('managed')
  expect(item.origin).toBe('brew:postgresql@16')
})

test('a system daemon starts at boot and keeps its path in the id', async () => {
  const items = await collect(
    {},
    {
      sys: {
        '/sys/Library/LaunchDaemons/com.acme.agent.plist': plist(
          '  <key>Label</key>\n  <string>com.acme.agent</string>\n  <key>Program</key>\n  <string>/Library/Acme/agent</string>',
        ),
        '/sys/Library/Acme/agent': { text: '\xcf\xfa\xed\xfe', exec: true },
      },
    },
  )
  const item = find(items, 'service:/Library/LaunchDaemons/com.acme.agent.plist')
  expect(item.category).toBe('manual')
  expect(item.path).toBe('/Library/LaunchDaemons/com.acme.agent.plist')
  expect(item.detail).toBe('starts /Library/Acme/agent at boot')
})

test('a disabled job says so, and disabling it is a change', async () => {
  const enabled = await collect(
    { [`${AGENTS}/local.x.plist`]: job('local.x', '/usr/bin/x') },
    { sys: { '/sys/usr/bin/x': { text: '#!/bin/sh\n', exec: true } } },
  )
  await fixture?.cleanup()
  const disabled = await collect(
    { [`${AGENTS}/local.x.plist`]: job('local.x', '/usr/bin/x', '  <key>Disabled</key>\n  <true/>') },
    { sys: { '/sys/usr/bin/x': { text: '#!/bin/sh\n', exec: true } } },
  )
  expect(find(disabled, 'service:local.x.plist').detail).toBe('starts /usr/bin/x, disabled')
  expect(find(disabled, 'service:local.x.plist').fingerprint).not.toBe(find(enabled, 'service:local.x.plist').fingerprint)
})

test('a version in a path is not a change', async () => {
  const sys = { '/sys/opt/acme/1.0.0/agent': { text: '#!/bin/sh\n', exec: true }, '/sys/opt/acme/1.1.0/agent': { text: '#!/bin/sh\n', exec: true } }
  const before = await collect({ [`${AGENTS}/local.acme.plist`]: job('local.acme', '/opt/acme/1.0.0/agent') }, { sys })
  await fixture?.cleanup()
  const after = await collect({ [`${AGENTS}/local.acme.plist`]: job('local.acme', '/opt/acme/1.1.0/agent') }, { sys })
  expect(find(after, 'service:local.acme.plist').fingerprint).toBe(find(before, 'service:local.acme.plist').fingerprint)
})

test('a program word with shell syntax is never shown', async () => {
  const items = await collect({ [`${AGENTS}/local.sh.plist`]: job('local.sh', `x;curl&amp;${TOKEN}`) })
  const item = find(items, 'service:local.sh.plist')
  expect(item.detail).toBe('starts a command at login')
  expect(JSON.stringify(items)).not.toContain(TOKEN)
})

test('a binary property list is listed by name and hash', async () => {
  const items = await collect({ [`${AGENTS}/com.acme.sync.plist`]: 'bplist00\u0000\u0001binary' })
  const item = find(items, 'service:com.acme.sync.plist')
  expect(item.category).toBe('manual')
  expect(item.detail).toBe('binary property list')
  expect(item.fingerprint).toMatch(/^[0-9a-f]{16}$/)
})

test('a link to a job file that is missing was left behind', async () => {
  const items = await collect({ [`${AGENTS}/local.gone.plist`]: { link: '~/dotfiles/local.gone.plist' } })
  expect(find(items, 'service:local.gone.plist').category).toBe('orphan')
})

test('system folders are not read when the scan stays inside the home', async () => {
  fixture = await makeHome({}, { sys: { '/sys/Library/LaunchDaemons/com.acme.agent.plist': plist('') } })
  expect(await collectLaunchd({ ...fixture.ctx, root: null })).toEqual([])
})
