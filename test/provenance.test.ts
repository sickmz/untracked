import { afterEach, describe, expect, test } from 'bun:test'
import { resolveOrigin } from '../src/provenance'
import type { Context } from '../src/types'
import { type Fixture, makeHome } from './fixture'

const ELF = '\x7fELF\x02\x01\x01\x00compiled'
const SCRIPT = '#!/bin/sh\necho hello\n'

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

// The real path of a "/sys/..." file is only known once the fixture exists, so dpkg answers are added here.
function withDpkg(fx: Fixture, owners: Record<string, string>): Context {
  const answers = new Map<string, string>()
  for (const [path, owner] of Object.entries(owners)) answers.set(fx.place(path), `${owner}: ${fx.place(path)}\n`)
  return {
    ...fx.ctx,
    run: async (cmd, args) => {
      const stdout = cmd === 'dpkg' && args[0] === '-S' ? answers.get(args[1] ?? '') : undefined
      return stdout == null ? { code: 1, stdout: '' } : { code: 0, stdout }
    },
  }
}

describe('resolveOrigin', () => {
  test('a link to a file a system package owns is managed by dpkg', async () => {
    fixture = await makeHome({ '.local/bin/jq': { link: '/sys/bin/jq' } }, { sys: { '/sys/bin/jq': { text: ELF, exec: true } } })
    const ctx = withDpkg(fixture, { '/sys/bin/jq': 'jq' })
    const found = await resolveOrigin(ctx, fixture.place('~/.local/bin/jq'))
    expect(found.category).toBe('managed')
    expect(found.origin).toBe('dpkg:jq')
  })

  test('a link to a system file no package owns is the user\'s own, unless the path is versioned', async () => {
    fixture = await makeHome(
      { '.local/bin/tool': { link: '/sys/opt/tool' }, '.local/bin/acme': { link: '/sys/opt/acme/2.4.1/bin/acme' } },
      { sys: { '/sys/opt/tool': { text: ELF, exec: true }, '/sys/opt/acme/2.4.1/bin/acme': { text: ELF, exec: true } } },
    )
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/tool'))).category).toBe('manual')
    const versioned = await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/acme'))
    expect(versioned.category).toBe('installed')
    expect(versioned.origin).toBe('system')
  })

  test('a script that does other work before exec is the user\'s own', async () => {
    fixture = await makeHome({
      'bin/backup': { text: '#!/bin/sh\nrsync -a ~/data backup:/srv\nexec /opt/tool/current/bin/tool "$@"\n', exec: true },
    })
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/bin/backup'))).category).toBe('manual')
  })

  test('a script in the bin folder of a hidden directory is the user\'s own', async () => {
    fixture = await makeHome({
      '.dotfiles/bin/deploy': { text: '#!/bin/sh\necho deploy\n', exec: true },
      '.acme/bin/acme': { text: '#!/bin/sh\necho acme\n', exec: true },
      '.acme/bin/helper': { text: ELF, exec: true },
    })
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.dotfiles/bin/deploy'))).category).toBe('manual')
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.acme/bin/acme'))).origin).toBe('installer:acme')
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.acme/bin/helper'))).origin).toBe('installer:acme')
  })

  test('npm global bins name their package, scoped names included', async () => {
    fixture = await makeHome({
      '.npm-global/lib/node_modules/acme-cli/bin/acme.js': { text: '#!/usr/bin/env node\n', exec: true },
      '.npm-global/lib/node_modules/@acme/lint/bin/lint.js': { text: '#!/usr/bin/env node\n', exec: true },
      '.npm-global/bin/acme': { link: '~/.npm-global/lib/node_modules/acme-cli/bin/acme.js' },
      '.npm-global/bin/lint': { link: '~/.npm-global/lib/node_modules/@acme/lint/bin/lint.js' },
    })
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.npm-global/bin/acme'))).origin).toBe('npm:acme-cli')
    const scoped = await resolveOrigin(fixture.ctx, fixture.place('~/.npm-global/bin/lint'))
    expect(scoped.category).toBe('managed')
    expect(scoped.origin).toBe('npm:@acme/lint')
  })

  test('bun global bins are managed by bun', async () => {
    fixture = await makeHome({
      '.bun/install/global/node_modules/fetch-logs/cli.js': { text: '#!/usr/bin/env bun\n', exec: true },
      '.bun/bin/fetch-logs': { link: '~/.bun/install/global/node_modules/fetch-logs/cli.js' },
    })
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.bun/bin/fetch-logs'))).origin).toBe('bun:fetch-logs')
  })

  test('pip, cargo and go read their own records', async () => {
    fixture = await makeHome({
      '.local/lib/python3.11/site-packages/acme_tool-1.0.0.dist-info/RECORD':
        'acme_tool/__init__.py,sha256=x,10\n../../../bin/acme-tool,sha256=y,20\n',
      '.local/bin/acme-tool': { text: '#!/usr/bin/python3\nimport acme_tool\n', exec: true },
      '.cargo/.crates.toml': '[v1]\n"fast-grep 1.2.0 (registry+https://example.invalid/index)" = ["fg"]\n',
      '.cargo/bin/fg': { text: ELF, exec: true },
      'go/bin/stringer': { text: ELF, exec: true },
    })
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/acme-tool'))).origin).toBe('pip:acme_tool')
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.cargo/bin/fg'))).origin).toBe('cargo:fast-grep')
    const go = await resolveOrigin(fixture.ctx, fixture.place('~/go/bin/stringer'))
    expect(go.category).toBe('managed')
    expect(go.origin).toBe('go:stringer')
  })

  test('a link into a versioned folder was put there by an installer', async () => {
    fixture = await makeHome({
      '.local/share/acme-cli/v2/current/bin/acme': { text: ELF, exec: true },
      '.local/bin/acme': { link: '~/.local/share/acme-cli/v2/current/bin/acme' },
    })
    const found = await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/acme'))
    expect(found.category).toBe('installed')
    expect(found.origin).toBe('installer:acme-cli')
  })

  test('a tiny wrapper that execs a versioned path was put there by an installer', async () => {
    fixture = await makeHome({
      '.config/acme-cli/2.4.1/bin/acme': { text: ELF, exec: true },
      '.local/bin/acme': { text: '#!/bin/sh\n# generated\nexec "$HOME/.config/acme-cli/2.4.1/bin/acme" "$@"\n', exec: true },
    })
    const found = await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/acme'))
    expect(found.category).toBe('installed')
    expect(found.origin).toBe('installer:acme-cli')
  })

  test('a long script that happens to exec a versioned path stays manual', async () => {
    fixture = await makeHome({
      '.local/bin/acme': { text: '#!/bin/sh\nset -e\ncd /tmp\necho start\nexec "$HOME/.acme/v2/acme"\n', exec: true },
    })
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/acme'))).category).toBe('manual')
  })

  test('a file in the bin folder of a hidden top-level folder was put there by an installer', async () => {
    fixture = await makeHome({ '.acme/bin/acme': { text: ELF, exec: true } })
    const found = await resolveOrigin(fixture.ctx, fixture.place('~/.acme/bin/acme'))
    expect(found.category).toBe('installed')
    expect(found.origin).toBe('installer:acme')
  })

  test('a hand-written script in ~/.local/bin is manual', async () => {
    fixture = await makeHome({ '.local/bin/backup': { text: SCRIPT, exec: true } })
    const found = await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/backup'))
    expect(found.category).toBe('manual')
    expect(found.origin).toBeUndefined()
    expect(found.detail).toBe('')
  })

  test('a link to a hand-written script in a plain folder is manual, not installed', async () => {
    fixture = await makeHome({
      'my-skills/check/bin/check': { text: SCRIPT, exec: true },
      '.local/bin/check': { link: '~/my-skills/check/bin/check' },
    })
    const found = await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/check'))
    expect(found.category).toBe('manual')
    expect(found.detail).toContain('link to ~/my-skills/check/bin/check')
  })

  test('a compiled file in a plain folder is manual', async () => {
    fixture = await makeHome({ 'tools/fetch-logs': { text: ELF, exec: true } })
    const found = await resolveOrigin(fixture.ctx, fixture.place('~/tools/fetch-logs'))
    expect(found.category).toBe('manual')
    expect(found.detail).toBe('')
  })

  test('a missing target does not throw', async () => {
    fixture = await makeHome({ '.local/bin/gone': { link: '~/x/y' } })
    expect((await resolveOrigin(fixture.ctx, fixture.place('~/.local/bin/gone'))).category).toBe('orphan')
  })
})
