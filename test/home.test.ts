import { afterEach, expect, test } from 'bun:test'
import { chmod } from 'node:fs/promises'
import { cleanUrl, collectHome } from '../src/collectors/home'
import { hashText } from '../src/lib/fs'
import type { Item } from '../src/types'
import { type Fixture, type FixtureOptions, makeHome, type Tree } from './fixture'

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

async function collect(tree: Tree, options: FixtureOptions = {}): Promise<Item[]> {
  fixture = await makeHome(tree, options)
  return collectHome(fixture.ctx)
}

function find(items: Item[], id: string): Item | undefined {
  return items.find((item) => item.id === id)
}

function gitConfig(url: string): string {
  return `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
}

test('a file identical to the skel copy is skipped', async () => {
  const items = await collect({ '.inputrc': 'set bell-style none\n' }, { skel: { '.inputrc': 'set bell-style none\n' } })
  expect(items).toEqual([])
})

test('a small hand-written dotfile is a config with a content fingerprint', async () => {
  const text = '[user]\n\tname = Ada Example\n'
  const items = await collect(
    { '.gitconfig': text, '.inputrc': 'set editing-mode vi\n' },
    { skel: { '.inputrc': 'set bell-style none\n' }, sys: { '/sys/bin/git': { text: '', exec: true } }, path: ['/sys/bin'] },
  )
  expect(find(items, 'config:~/.gitconfig')).toEqual({
    id: 'config:~/.gitconfig',
    kind: 'config',
    category: 'manual',
    name: '.gitconfig',
    detail: '',
    path: '~/.gitconfig',
    fingerprint: hashText(text),
  })
  expect(find(items, 'config:~/.inputrc')?.category).toBe('manual')
})

test('shell startup files are left to the shell collector', async () => {
  const items = await collect({ '.bashrc': 'alias ll="ls -l"\n', '.zshrc': 'setopt autocd\n', '.profile': 'umask 022\n' })
  expect(items).toEqual([])
})

test('history and state files are ignored', async () => {
  const items = await collect({
    '.bash_history': 'ls\n',
    '.python_history': 'print(1)\n',
    '.lesshst': '.less-history-file:\n',
    '.wget-hsts': '# HSTS\n',
    '.viminfo': '# viminfo\n',
    '.sudo_as_admin_successful': '',
    '.motd_shown': '',
    '.Xauthority': 'x',
    '.zcompdump-host-5.9': '#files: 800\n',
    '.cache/acme/blob': 'x',
    '.gnupg/pubring.kbx': 'x',
  })
  expect(items).toEqual([])
})

test('a large hidden json is program state, not config', async () => {
  const big = JSON.stringify({ entries: 'x'.repeat(100 * 1024) })
  const items = await collect({ '.acme-state.json': big })
  const item = find(items, 'state_dir:~/.acme-state.json')
  expect(item?.kind).toBe('state_dir')
  expect(item?.category).toBe('unclaimed')
  expect(item?.fingerprint).toBe('')
  expect(items.some((entry) => entry.kind === 'config')).toBe(false)
})

test('a binary hidden file is program state', async () => {
  const items = await collect({ '.acme.db': 'SQLite format 3\0\0\0' })
  expect(find(items, 'state_dir:~/.acme.db')?.kind).toBe('state_dir')
})

test('a directory is claimed by a command sharing a name prefix', async () => {
  const items = await collect(
    { '.acme-cli/settings.json': '{}', '.azure/profile.json': '{}' },
    { sys: { '/sys/bin/acme': { text: '', exec: true }, '/sys/bin/az': { text: '', exec: true } }, path: ['/sys/bin'] },
  )
  expect(find(items, 'state_dir:~/.acme-cli')).toEqual({
    id: 'state_dir:~/.acme-cli',
    kind: 'state_dir',
    category: 'installed',
    name: '.acme-cli',
    detail: 'kept by acme',
    path: '~/.acme-cli',
    origin: 'app:acme',
    fingerprint: '',
  })
  expect(find(items, 'state_dir:~/.azure')?.category).toBe('unclaimed')
})

test('a two-letter command does not claim a longer name', async () => {
  const items = await collect(
    { '.vitest/results.json': '{}', '.kube/config.yaml': '' },
    { sys: { '/sys/bin/vi': { text: '', exec: true }, '/sys/bin/kubectl': { text: '', exec: true } }, path: ['/sys/bin'] },
  )
  expect(find(items, 'state_dir:~/.vitest')?.category).toBe('unclaimed')
  expect(find(items, 'state_dir:~/.kube')?.origin).toBe('app:kubectl')
})

test('a directory is claimed by a system package sharing its first word', async () => {
  const items = await collect(
    { '.azure/profile.json': '{}', '.azure-devops/cache.json': '{}', '.orbit/state.json': '{}' },
    { run: { 'dpkg-query -W -f ${Package}\\n': { code: 0, stdout: 'azure-cli\ncoreutils\n' } } },
  )
  expect(find(items, 'state_dir:~/.azure')?.origin).toBe('dpkg:azure-cli')
  expect(find(items, 'state_dir:~/.azure-devops')?.origin).toBe('dpkg:azure-cli')
  expect(find(items, 'state_dir:~/.orbit')?.category).toBe('unclaimed')
})

test('the command with the same name wins over a link that resolves inside', async () => {
  const items = await collect(
    { '.acme/skills/check/bin/check': { text: '#!/bin/sh\n', exec: true }, '.local/bin/check': { link: '~/.acme/skills/check/bin/check' } },
    { sys: { '/sys/bin/acme': { text: '', exec: true } }, path: ['~/.local/bin', '/sys/bin'] },
  )
  expect(find(items, 'state_dir:~/.acme')?.origin).toBe('app:acme')
})

test('the closest command name wins the claim', async () => {
  const items = await collect(
    { '.acme/data': 'x' },
    {
      sys: { '/sys/bin/acme': { text: '', exec: true }, '/sys/bin/acme-helper': { text: '', exec: true } },
      path: ['/sys/bin'],
    },
  )
  expect(find(items, 'state_dir:~/.acme')?.origin).toBe('app:acme')
})

test('a directory is claimed by a PATH link that resolves into it', async () => {
  const items = await collect(
    {
      '.zeta-tools/1.4.2/bin/zt': { text: '', exec: true },
      '.local/bin/zt': { link: '~/.zeta-tools/1.4.2/bin/zt' },
    },
    { path: ['~/.local/bin'] },
  )
  const item = find(items, 'state_dir:~/.zeta-tools')
  expect(item?.category).toBe('installed')
  expect(item?.origin).toBe('app:zt')
})

test('a directory holding a PATH directory is claimed', async () => {
  const items = await collect({ '.qux/bin': { dir: true } }, { path: ['~/.qux/bin'] })
  expect(find(items, 'state_dir:~/.qux')?.category).toBe('installed')
})

test('a directory no program matches is unclaimed', async () => {
  const items = await collect(
    { '.oldtool/state.json': '{}' },
    { sys: { '/sys/bin/acme': { text: '', exec: true } }, path: ['/sys/bin'] },
  )
  expect(find(items, 'state_dir:~/.oldtool')).toEqual({
    id: 'state_dir:~/.oldtool',
    kind: 'state_dir',
    category: 'unclaimed',
    name: '.oldtool',
    detail: '',
    path: '~/.oldtool',
    fingerprint: '',
  })
})

test('a one-letter command claims nothing', async () => {
  const items = await collect({ '.q/state': 'x' }, { sys: { '/sys/bin/q': { text: '', exec: true } }, path: ['/sys/bin'] })
  expect(find(items, 'state_dir:~/.q')?.category).toBe('unclaimed')
})

test('children of .config and .local/share are application directories', async () => {
  const items = await collect(
    {
      '.config/acme/config.toml': 'x = 1\n',
      '.config/oldtool/settings.ini': 'a=b\n',
      '.config/user-dirs.dirs': 'XDG_DESKTOP_DIR="$HOME/Desktop"\n',
      '.local/share/acme/db': 'x',
      '.local/state/oldtool/log': 'x',
      '.local/bin/acme': { text: '', exec: true },
      '.local/lib/python/site.py': '',
    },
    { path: ['~/.local/bin'] },
  )
  expect(find(items, 'state_dir:~/.config/acme')?.category).toBe('installed')
  expect(find(items, 'state_dir:~/.config/oldtool')?.category).toBe('unclaimed')
  expect(find(items, 'state_dir:~/.local/share/acme')?.category).toBe('installed')
  expect(find(items, 'state_dir:~/.local/state/oldtool')?.category).toBe('unclaimed')
  const ids = items.map((item) => item.id).sort()
  expect(ids).toEqual([
    'state_dir:~/.config/acme',
    'state_dir:~/.config/oldtool',
    'state_dir:~/.local/share/acme',
    'state_dir:~/.local/state/oldtool',
  ])
})

test("untracked's own directories are ignored", async () => {
  const items = await collect({
    '.config/untracked/notes.json': '{}',
    '.local/state/untracked/snapshot.json': '{}',
  })
  expect(items).toEqual([])
})

test('nested hand-written configs are reported, never credentials or keys', async () => {
  const items = await collect({
    '.ssh/config': 'Host build\n  HostName build.example.test\n',
    '.ssh/id_ed25519': 'PRIVATE',
    '.ssh/known_hosts': 'x',
    '.aws/config': '[default]\nregion = eu-south-1\n',
    '.aws/credentials': '[default]\naws_secret_access_key = SECRET\n',
    '.config/git/config': '[core]\n\teditor = vim\n',
  })
  expect(find(items, 'config:~/.ssh/config')?.category).toBe('manual')
  expect(find(items, 'config:~/.aws/config')?.category).toBe('manual')
  expect(find(items, 'config:~/.config/git/config')?.category).toBe('manual')
  const paths = items.map((item) => item.path)
  expect(paths).not.toContain('~/.ssh/id_ed25519')
  expect(paths).not.toContain('~/.aws/credentials')
  expect(JSON.stringify(items)).not.toContain('SECRET')
})

test('a checkout with a password in its remote never shows the password', async () => {
  const items = await collect({
    'shop-api/.git/config': gitConfig('https://dev:hunter2@git.example.test/acme/shop-api.git'),
    'shop-api/README.md': '# shop\n',
  })
  expect(find(items, 'repo:~/shop-api')).toEqual({
    id: 'repo:~/shop-api',
    kind: 'repo',
    category: 'manual',
    name: 'shop-api',
    detail: 'https://git.example.test/acme/shop-api.git',
    path: '~/shop-api',
    origin: 'https://git.example.test/acme/shop-api.git',
    fingerprint: 'https://git.example.test/acme/shop-api.git',
  })
  expect(JSON.stringify(items)).not.toContain('hunter2')
  expect(JSON.stringify(items)).not.toContain('dev:')
})

test('a checkout without a remote', async () => {
  const items = await collect({ 'notes/.git/config': '[core]\n\tbare = false\n' })
  const item = find(items, 'repo:~/notes')
  expect(item?.detail).toBe('no remote')
  expect(item?.fingerprint).toBe('')
  expect(item?.origin).toBeUndefined()
})

test('a container directory with two checkouts', async () => {
  const items = await collect({
    'projects/shop-api/.git/config': gitConfig('git@git.example.test:acme/shop-api.git'),
    'projects/acme-cli/.git/config': gitConfig('https://git.example.test/acme/acme-cli.git'),
    'projects/scratch/todo.txt': 'x',
    'projects/scratch/deep/.git/config': gitConfig('https://git.example.test/acme/deep.git'),
    'projects/plan.md': '# plan\n',
  })
  const ids = items.map((item) => item.id).sort()
  expect(ids).toEqual(['dir:~/projects', 'repo:~/projects/acme-cli', 'repo:~/projects/shop-api'])
  expect(find(items, 'dir:~/projects')).toEqual({
    id: 'dir:~/projects',
    kind: 'dir',
    category: 'manual',
    name: 'projects',
    detail: '',
    path: '~/projects',
    fingerprint: '',
  })
  expect(find(items, 'repo:~/projects/shop-api')?.detail).toBe('git@git.example.test:acme/shop-api.git')
})

test('nothing inside a checkout is read', async () => {
  const items = await collect({
    'shop-api/.git/config': gitConfig('https://git.example.test/acme/shop-api.git'),
    'shop-api/vendor/lib/.git/config': gitConfig('https://git.example.test/acme/lib.git'),
    'shop-api/.config/acme/x': 'x',
    'shop-api/.toolrc': 'x=1\n',
  })
  expect(items.map((item) => item.id)).toEqual(['repo:~/shop-api'])
})

test('visible files are not reported, visible directories are', async () => {
  const items = await collect({ 'notes.txt': 'x', Desktop: { dir: true }, 'fonts/acme.ttf': 'x' })
  expect(items.map((item) => item.id).sort()).toEqual(['dir:~/Desktop', 'dir:~/fonts'])
})

test('an unreadable hidden file is skipped without failing the scan', async () => {
  if (process.getuid?.() === 0) throw new Error('this test cannot run as root')
  fixture = await makeHome({ '.rootrc': 'x=1\n', '.gitconfig': '[user]\n' })
  await chmod(fixture.place('~/.rootrc'), 0o000)
  const items = await collectHome(fixture.ctx)
  expect(items.map((item) => item.id)).toEqual(['config:~/.gitconfig'])
})

test('the same PATH directory listed twice is read once and still claims', async () => {
  const items = await collect(
    { '.acme/x': 'x' },
    { sys: { '/sys/bin/acme': { text: '', exec: true } }, path: ['/sys/bin', '/sys/bin/'] },
  )
  expect(find(items, 'state_dir:~/.acme')?.origin).toBe('app:acme')
})

test('cleanUrl drops credentials and keeps an ssh user', () => {
  expect(cleanUrl('https://dev:p@ss@git.example.test/a.git')).toBe('https://git.example.test/a.git')
  expect(cleanUrl('https://token123@git.example.test/a.git')).toBe('https://git.example.test/a.git')
  expect(cleanUrl('ssh://git@git.example.test/a.git')).toBe('ssh://git@git.example.test/a.git')
  expect(cleanUrl('ssh://git:secret@git.example.test/a.git')).toBe('ssh://git.example.test/a.git')
  expect(cleanUrl('git@git.example.test:a.git')).toBe('git@git.example.test:a.git')
  expect(cleanUrl('https://git.example.test/a@b.git')).toBe('https://git.example.test/a@b.git')
})

test('two scans of an unchanged home give the same items', async () => {
  fixture = await makeHome(
    { '.gitconfig': '[user]\n', '.acme/x': 'x', 'projects/shop-api/.git/config': gitConfig('https://git.example.test/a.git') },
    { sys: { '/sys/bin/acme': { text: '', exec: true } }, path: ['/sys/bin'] },
  )
  const first = await collectHome(fixture.ctx)
  const second = await collectHome(fixture.ctx)
  expect(second).toEqual(first)
})

test('cleanUrl handles quoted values, query strings and the short ssh form', () => {
  expect(cleanUrl('"https://dev:tok3n@git.example.test/a.git"')).toBe('https://git.example.test/a.git')
  expect(cleanUrl('https://git.example.test/a.git?private_token=tok3n#frag')).toBe('https://git.example.test/a.git')
  expect(cleanUrl('git@git.example.test:team/a.git')).toBe('git@git.example.test:team/a.git')
  expect(cleanUrl('dev:tok3n@git.example.test:team/a.git')).toBe('git.example.test:team/a.git')
})

test('a quoted remote with a token never reaches an item', async () => {
  const items = await collect({
    'code/a/.git/config': '[remote "origin"]\n\turl = "https://dev:tok3nSECRET@git.example.test/x/a.git?key=qSECRET"\n',
  })
  const text = JSON.stringify(items)
  expect(text).not.toContain('SECRET')
  expect(find(items, 'repo:~/code/a')?.detail).toBe('https://git.example.test/x/a.git')
})

test('a hand-made hidden directory is not claimed by a shorter command name', async () => {
  const items = await collect(
    { '.scripts/run.sh': '' },
    { sys: { '/sys/bin/script': { text: '', exec: true } }, path: ['/sys/bin'] },
  )
  expect(find(items, 'state_dir:~/.scripts')?.category).toBe('unclaimed')
})

test('a hidden JSON file and a shell history are not hand-written config', async () => {
  const items = await collect({ '.acme.json': '{"last_run": 1}', '.histfile': 'ls\n', '.z': '/tmp|1|1\n' })
  expect(items.some((item) => item.kind === 'config')).toBe(false)
  expect(find(items, 'state_dir:~/.acme.json')?.category).toBe('unclaimed')
})

test('ssh keys are listed by name, and the private half never reaches an item', async () => {
  const items = await collect({
    '.ssh/id_work': '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATESECRETBODY\n-----END OPENSSH PRIVATE KEY-----\n',
    '.ssh/id_work.pub': 'ssh-ed25519 AAAAC3Nza dev@laptop\n',
    '.ssh/deploy.pem': '-----BEGIN RSA PRIVATE KEY-----\nPEMSECRETBODY\n-----END RSA PRIVATE KEY-----\n',
    '.ssh/old.pub': 'ssh-rsa AAAAB3Nza dev@old\n',
    '.ssh/known_hosts': 'git.example.test ssh-ed25519 AAAA\n',
    '.ssh/authorized_keys': 'ssh-ed25519 AAAAC3Nza dev@laptop\n',
    '.ssh/notes.txt': 'not a key\n',
  })
  const keys = items.filter((item) => item.kind === 'key')
  expect(keys.map((item) => `${item.id} ${item.detail}`).sort()).toEqual([
    'key:~/.ssh/deploy.pem no public half next to it',
    'key:~/.ssh/id_work ',
    'key:~/.ssh/old public half only',
  ])
  expect(find(items, 'key:~/.ssh/id_work')?.fingerprint).not.toBe('')
  expect(find(items, 'key:~/.ssh/deploy.pem')?.fingerprint).toBe('')
  expect(find(items, 'config:~/.ssh/authorized_keys')?.kind).toBe('config')
  expect(items.some((item) => item.id.includes('known_hosts'))).toBe(false)
  expect(JSON.stringify(items)).not.toContain('SECRETBODY')
})

test('cleanUrl drops a password that holds "?" or "#"', () => {
  expect(cleanUrl('https://user:se?cret@host.test/debian')).toBe('https://host.test/debian')
  expect(cleanUrl('https://user:pa#ss@host.test/debian')).toBe('https://host.test/debian')
  // Ambiguous: what comes before the last "@" is dropped, so a token can never stay.
  expect(cleanUrl('https://host.test?token=a@b')).not.toContain('token')
  expect(cleanUrl('ssh://git@host.test/a.git#frag')).toBe('ssh://git@host.test/a.git')
})
