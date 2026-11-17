import { afterEach, expect, test } from 'bun:test'
import { collectServices } from '../src/collectors/services'
import type { Item } from '../src/types'
import { type Fixture, type FixtureOptions, makeHome, type Tree } from './fixture'

const UNIT_DIR = '.config/systemd/user'
let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

async function collect(tree: Tree, options: FixtureOptions = {}): Promise<Item[]> {
  fixture = await makeHome(tree, options)
  return collectServices(fixture.ctx)
}

function crontab(stdout: string): FixtureOptions['run'] {
  return { 'crontab -l': { code: 0, stdout } }
}

function find(items: Item[], id: string): Item {
  const item = items.find((candidate) => candidate.id === id)
  if (item == null) throw new Error(`no item ${id}`)
  return item
}

test('a unit starting a hand-made script is manual and not enabled', async () => {
  const items = await collect({
    'tools/sync-notes': { text: '#!/bin/sh\n', exec: true },
    [`${UNIT_DIR}/sync-notes.service`]: '[Unit]\nDescription=x\n[Service]\nExecStart=%h/tools/sync-notes --fast\n',
  })
  expect(items).toHaveLength(1)
  const item = find(items, 'service:sync-notes.service')
  expect(item.kind).toBe('service')
  expect(item.category).toBe('manual')
  expect(item.path).toBe(`~/${UNIT_DIR}/sync-notes.service`)
  expect(item.detail).toBe('starts ~/tools/sync-notes, not enabled')
  expect(item.fingerprint).toMatch(/^[0-9a-f]{16}$/)
})

test('a unit linked from a wants directory is enabled, and the wants directory is not an item', async () => {
  const items = await collect({
    'tools/sync-notes': { text: '', exec: true },
    [`${UNIT_DIR}/sync-notes.service`]: '[Service]\nExecStart=-%h/tools/sync-notes\n',
    [`${UNIT_DIR}/default.target.wants/sync-notes.service`]: { link: `~/${UNIT_DIR}/sync-notes.service` },
  })
  expect(items.map((item) => item.id)).toEqual(['service:sync-notes.service'])
  expect(items[0]?.detail).toBe('starts ~/tools/sync-notes at login')
})

test('a unit whose program is missing is an orphan', async () => {
  const items = await collect({
    [`${UNIT_DIR}/gone.service`]: '[Service]\nExecStart=%h/tools/gone\n',
    [`${UNIT_DIR}/bare.service`]: '[Service]\nExecStart=acme-daemon --serve\n',
  })
  const gone = find(items, 'service:gone.service')
  expect(gone.category).toBe('orphan')
  expect(gone.detail).toBe('starts ~/tools/gone, which is missing')
  expect(gone.fingerprint).toBe('')
  expect(find(items, 'service:bare.service').detail).toBe('starts acme-daemon, which is missing')
})

test('a bare program found on PATH is not missing', async () => {
  const items = await collect(
    { [`${UNIT_DIR}/acme.service`]: '[Service]\nExecStart=acme-daemon --serve\n' },
    { path: ['/sys/bin'], sys: { '/sys/bin/acme-daemon': { text: '', exec: true } } },
  )
  expect(find(items, 'service:acme.service').category).toBe('manual')
})

test('a unit is the same after an update moves the version in its paths', async () => {
  const before = await collect({
    '.acme-cli/versions/2.4.1/acme-agent': { text: '', exec: true },
    [`${UNIT_DIR}/acme-agent.service`]: '[Service]\nExecStart="%h/.acme-cli/versions/2.4.1/acme-agent" run\n',
  })
  const after = await collect({
    '.acme-cli/versions/2.5.0/acme-agent': { text: '', exec: true },
    [`${UNIT_DIR}/acme-agent.service`]: '[Service]\nExecStart="%h/.acme-cli/versions/2.5.0/acme-agent" run\n',
  })
  const item = find(before, 'service:acme-agent.service')
  expect(item.category).toBe('manual')
  expect(item.fingerprint).toBe(find(after, 'service:acme-agent.service').fingerprint)
})

test('enabling a unit or editing it is a change', async () => {
  const unit = '[Service]\nExecStart=%h/tools/sync\n'
  const tool = { 'tools/sync': { text: '#!/bin/sh\n', exec: true } }
  const plain = await collect({ ...tool, [`${UNIT_DIR}/sync.service`]: unit })
  const enabled = await collect({
    ...tool,
    [`${UNIT_DIR}/sync.service`]: unit,
    [`${UNIT_DIR}/default.target.wants/sync.service`]: { link: `~/${UNIT_DIR}/sync.service` },
  })
  const edited = await collect({ ...tool, [`${UNIT_DIR}/sync.service`]: `${unit}Restart=always\n` })
  const fingerprint = find(plain, 'service:sync.service').fingerprint
  expect(fingerprint).not.toBe('')
  expect(find(enabled, 'service:sync.service').fingerprint).not.toBe(fingerprint)
  expect(find(edited, 'service:sync.service').fingerprint).not.toBe(fingerprint)
})

test('a command continued on the next line is read whole', async () => {
  const items = await collect({
    'tools/sync': { text: '#!/bin/sh\n', exec: true },
    [`${UNIT_DIR}/sync.service`]: '[Service]\nExecStart=\\\n  %h/tools/sync --all\n',
  })
  const item = find(items, 'service:sync.service')
  expect(item.category).toBe('manual')
  expect(item.detail).toBe('starts ~/tools/sync, not enabled')
})

test('a timer is manual and names the unit it runs', async () => {
  const items = await collect({
    [`${UNIT_DIR}/backup.timer`]: '[Timer]\nOnCalendar=daily\n',
    [`${UNIT_DIR}/timers.target.wants/backup.timer`]: { link: `~/${UNIT_DIR}/backup.timer` },
    [`${UNIT_DIR}/notes.timer`]: '[Timer]\nOnCalendar=hourly\nUnit=sync-notes.service\n',
    [`${UNIT_DIR}/README.md`]: 'not a unit',
  })
  expect(items).toHaveLength(2)
  const backup = find(items, 'service:backup.timer')
  expect(backup.category).toBe('manual')
  expect(backup.detail).toBe('runs backup.service on a timer, enabled')
  expect(backup.fingerprint).not.toBe('')
  expect(find(items, 'service:notes.timer').detail).toBe('runs sync-notes.service on a timer, not enabled')
})

test('a program holding a specifier cannot be proven missing', async () => {
  const items = await collect({ [`${UNIT_DIR}/acme.service`]: '[Service]\nExecStart=/run/user/%U/acme-agent\n' })
  expect(find(items, 'service:acme.service').category).toBe('manual')
})

test('a unit link whose target is gone is an orphan', async () => {
  const items = await collect({ [`${UNIT_DIR}/lost.service`]: { link: '~/units/lost.service' } })
  expect(find(items, 'service:lost.service').category).toBe('orphan')
})

test('no crontab gives no items', async () => {
  expect(await collect({}, { run: { 'crontab -l': { code: 1, stdout: '' } } })).toEqual([])
  await fixture?.cleanup()
  expect(await collect({})).toEqual([])
})

test('crontab jobs: comments and env lines are skipped, both schedule forms are read', async () => {
  const stdout = [
    '# backups',
    '',
    'MAILTO=someone',
    'PATH = /usr/bin:/bin',
    '0 3 * * *   ~/tools/backup --all',
    '@reboot $HOME/tools/sync-notes',
    '@daily ~/tools/backup --quick',
  ].join('\n')
  const items = await collect(
    { 'tools/backup': { text: '', exec: true }, 'tools/sync-notes': { text: '', exec: true } },
    { run: crontab(stdout) },
  )
  expect(items).toHaveLength(3)
  for (const item of items) {
    expect(item.kind).toBe('cron')
    expect(item.category).toBe('manual')
    expect(item.id).toBe(`cron:${item.fingerprint}`)
  }
  expect(items.map((item) => item.detail).sort()).toEqual([
    'runs ~/tools/backup on schedule 0 3 * * *',
    'runs ~/tools/backup on schedule @daily',
    'runs ~/tools/sync-notes at startup',
  ])
  expect(items.map((item) => item.name).sort()).toEqual(['backup', 'backup', 'sync-notes'])
})

test('a job whose program is missing is an orphan, a shell builtin is not', async () => {
  const stdout = '*/5 * * * * ~/tools/gone\n0 * * * * cd ~/notes && make\n@daily (cd ~/notes && make)\n@hourly $BIN/acme\n'
  const items = await collect({}, { run: crontab(stdout) })
  const details = items.map((item) => `${item.category} ${item.detail}`).sort()
  expect(details).toEqual([
    'manual runs a shell command on schedule @daily',
    'manual runs a shell command on schedule @hourly',
    'manual runs cd on schedule 0 * * * *',
    'orphan runs ~/tools/gone on schedule */5 * * * *, which is missing',
  ])
})

test('a repeated job line gives one item', async () => {
  const items = await collect({}, { run: crontab('@hourly ~/tools/gone\n@hourly ~/tools/gone\n') })
  expect(items).toHaveLength(1)
})

test('a secret in arguments or an env prefix appears nowhere in the items', async () => {
  const secret = 'hunter2-s3cret-token'
  const stdout = [
    `0 3 * * * ~/tools/backup --token ${secret}`,
    `@daily API_TOKEN=${secret} ~/tools/backup`,
    `@hourly API_TOKEN="${secret} x" ~/tools/backup % ${secret}`,
    `@weekly API_TOKEN=${secret};~/tools/backup`,
    `@monthly API_TOKEN=${secret}`,
  ].join('\n')
  const items = await collect(
    {
      'tools/backup': { text: '', exec: true },
      [`${UNIT_DIR}/backup.service`]: `[Service]\nExecStart=%h/tools/backup --token ${secret}\n`,
    },
    { run: crontab(stdout) },
  )
  expect(items).toHaveLength(6)
  expect(JSON.stringify(items)).not.toContain(secret)
  expect(JSON.stringify(items)).not.toContain('hunter2')
})

test('two scans of the same home give the same fingerprints', async () => {
  fixture = await makeHome(
    {
      'tools/sync-notes': { text: '', exec: true },
      [`${UNIT_DIR}/sync-notes.service`]: '[Service]\nExecStart=%h/tools/sync-notes\n',
    },
    { run: crontab('0 3 * * * ~/tools/sync-notes\n') },
  )
  const first = await collectServices(fixture.ctx)
  const second = await collectServices(fixture.ctx)
  expect(second).toEqual(first)
})

test('an assignment with an escaped space does not turn its value into the program', async () => {
  const items = await collect(
    {},
    { run: crontab('0 3 * * * PGPASSWORD=hunter2\\ SECRETPART /sys/bin/missing-dump db\n') },
  )
  expect(JSON.stringify(items)).not.toContain('SECRETPART')
  expect(items[0]?.name).toBe('missing-dump')
})

test('arguments inside a quoted command line are never shown', async () => {
  const items = await collect({
    [`${UNIT_DIR}/agent.service`]: '[Service]\nExecStart="/sys/bin/agent --token=UNITSECRET"\n',
  })
  expect(JSON.stringify(items)).not.toContain('UNITSECRET')
  expect(find(items, 'service:agent.service').detail).toBe('starts /sys/bin/agent, which is missing')
})
