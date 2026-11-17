import { afterEach, describe, expect, test } from 'bun:test'
import { collectReferences } from '../src/collectors/references'
import { hashText } from '../src/lib/fs'
import type { Item } from '../src/types'
import { type Fixture, type FixtureOptions, makeHome, type Tree } from './fixture'

const TOKEN = 'tok_0a1b2c3d4e5f6789fake'
const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

async function collect(tree: Tree, options: FixtureOptions = {}): Promise<Item[]> {
  const fixture = await makeHome(tree, options)
  fixtures.push(fixture)
  return collectReferences(fixture.ctx)
}

function claude(hooks: Record<string, string[]>, extra: Record<string, unknown> = {}): string {
  const tree: Record<string, unknown> = {}
  for (const [event, commands] of Object.entries(hooks)) {
    tree[event] = [{ matcher: '', hooks: commands.map((command) => ({ type: 'command', command })) }]
  }
  return JSON.stringify({ ...extra, hooks: tree })
}

const SCRIPT = '#!/bin/sh\necho hi\n'

describe('collectReferences', () => {
  test('reports a hook whose script exists as manual', async () => {
    const items = await collect({
      '.claude/settings.json': claude({ SessionStart: ['~/.claude/hooks/notify.sh --quiet'] }),
      '.claude/hooks/notify.sh': { text: SCRIPT, exec: true },
    })
    expect(items).toEqual([
      {
        id: 'hook:~/.claude/settings.json:SessionStart:~/.claude/hooks/notify.sh',
        kind: 'hook',
        category: 'manual',
        name: 'notify.sh',
        detail: '~/.claude/settings.json runs ~/.claude/hooks/notify.sh on SessionStart',
        path: '~/.claude/settings.json',
        fingerprint: hashText(SCRIPT),
      },
    ])
  })

  test('finds the script behind assignments and an interpreter', async () => {
    const items = await collect({
      '.claude/settings.json': claude({
        Stop: ['ACME_MODE="a b" bash "$HOME/.claude/hooks/stop.sh"', 'bun run ~/.claude/hooks/log.ts', 'sh -c "~/.claude/hooks/inline.sh x"'],
      }),
      '.claude/hooks/stop.sh': SCRIPT,
      '.claude/hooks/log.ts': 'console.log(1)\n',
    })
    const names = items.map((item) => `${item.name}:${item.category}`).sort()
    expect(names).toEqual(['inline.sh:orphan', 'log.ts:manual', 'stop.sh:manual'])
  })

  test('marks a hook whose script is missing as orphan', async () => {
    const items = await collect({
      '.claude/settings.json': claude({ PreToolUse: ['python3 ~/.claude/hooks/gone.py'] }),
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'hook:~/.claude/settings.json:PreToolUse:~/.claude/hooks/gone.py',
      category: 'orphan',
      name: 'gone.py',
      detail: 'names ~/.claude/hooks/gone.py, which is missing',
      fingerprint: '',
    })
  })

  test('checks a bare program on PATH', async () => {
    const items = await collect(
      { '.claude/settings.json': claude({ Stop: ['acme-cli notify --all', 'jq .'] }) },
      { sys: { '/sys/bin/jq': { text: SCRIPT, exec: true } }, path: ['/sys/bin'] },
    )
    expect(items.find((item) => item.name === 'acme-cli')).toMatchObject({
      category: 'orphan',
      detail: 'names acme-cli, which is missing',
    })
    expect(items.find((item) => item.name === 'jq')?.category).toBe('manual')
  })

  test('marks a script left by an uninstalled tool as orphan', async () => {
    const marked = '#!/bin/sh\n# Installed by acme. Do not edit.\necho hi\n'
    const tree: Tree = {
      '.claude/settings.json': claude({ SessionStart: ['~/.claude/hooks/acme.sh'] }),
      '.claude/hooks/acme.sh': { text: marked, exec: true },
    }
    const without = await collect(tree)
    expect(without[0]).toMatchObject({ category: 'orphan', detail: 'left by acme, which is not installed' })
    expect(without[0]?.fingerprint).toBe(hashText(marked))

    const with_tool = await collect(tree, {
      sys: { '/sys/bin/acme': { text: SCRIPT, exec: true } },
      path: ['/sys/bin'],
    })
    expect(with_tool[0]?.category).toBe('manual')
  })

  test('reports the status line command', async () => {
    const items = await collect({
      '.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/line.sh' } }),
      '.claude/line.sh': SCRIPT,
    })
    expect(items[0]).toMatchObject({
      id: 'hook:~/.claude/settings.json:statusLine:~/.claude/line.sh',
      detail: '~/.claude/settings.json runs ~/.claude/line.sh for its status line',
    })
  })

  test('walks codex hooks with events nested or at the top level', async () => {
    const nested = await collect({
      '.codex/hooks.json': JSON.stringify({ hooks: { session_start: [{ command: '~/.codex/start.sh' }] } }),
    })
    expect(nested[0]?.id).toBe('hook:~/.codex/hooks.json:session_start:~/.codex/start.sh')
    const top = await collect({
      '.codex/hooks.json': JSON.stringify({ stop: [{ hooks: [{ command: '~/.codex/stop.sh' }] }] }),
      '.codex/stop.sh': SCRIPT,
    })
    expect(top[0]).toMatchObject({ id: 'hook:~/.codex/hooks.json:stop:~/.codex/stop.sh', category: 'manual' })
  })

  test('returns nothing for a malformed or missing file', async () => {
    const items = await collect({
      '.claude/settings.json': '{ "hooks": { "Stop": [ ',
      '.codex/hooks.json': 'null',
    })
    expect(items).toEqual([])
    expect(await collect({})).toEqual([])
  })

  test('marks a core.hooksPath that points nowhere as orphan', async () => {
    const items = await collect({
      '.gitconfig': '[user]\n\tname = Example\n[core]\n\teditor = vim\n\thooksPath = ~/.githooks ; old\n',
      '.config/git/config': '[core "other"]\n\thooksPath = /nowhere\n[core]\n\thookspath = "~/.config/git/hooks"\n',
      '.config/git/hooks': { dir: true },
    })
    const by_path = Object.fromEntries(items.map((item) => [item.path, item]))
    expect(by_path['~/.gitconfig']).toMatchObject({
      id: 'hook:~/.gitconfig:core.hooksPath:~/.githooks',
      category: 'orphan',
      name: '.githooks',
      detail: 'names ~/.githooks, which is missing',
      fingerprint: '',
    })
    expect(by_path['~/.config/git/config']).toMatchObject({ category: 'manual', fingerprint: '' })
  })

  test('dedupes the same script on the same event', async () => {
    const items = await collect({
      '.claude/settings.json': claude({ Stop: ['~/.claude/hooks/x.sh --a', '~/.claude/hooks/x.sh --b'] }),
      '.claude/hooks/x.sh': SCRIPT,
    })
    expect(items).toHaveLength(1)
  })

  test('passes over builtins, launchers and interpreter arguments', async () => {
    const items = await collect(
      {
        '.claude/settings.json': claude({
          A: ['cd "$CLAUDE_PROJECT_DIR" && ~/.claude/hooks/a.sh'],
          B: ['python3 -W ignore ~/.claude/hooks/b.py'],
          C: ['bun run build'],
          D: ['node hook.js'],
          E: ["bash -lc '~/.claude/hooks/e.sh --flag'"],
          F: ['env -i ACME_MODE=1 ~/.claude/hooks/f.sh'],
          G: ['/usr/bin/env bash ~/.claude/hooks/g.sh'],
          H: ['[[ -f x ]] && exit 0'],
        }),
        '.claude/hooks/a.sh': SCRIPT,
        '.claude/hooks/b.py': SCRIPT,
        '.claude/hooks/e.sh': SCRIPT,
        '.claude/hooks/f.sh': SCRIPT,
        '.claude/hooks/g.sh': SCRIPT,
      },
      { sys: { '/sys/bin/bun': { text: SCRIPT, exec: true } }, path: ['/sys/bin'] },
    )
    const found = Object.fromEntries(items.map((item) => [item.id.split(':')[2], `${item.name}:${item.category}`]))
    expect(found).toEqual({
      A: 'a.sh:manual',
      B: 'b.py:manual',
      C: 'bun:manual',
      D: 'hook.js:manual',
      E: 'e.sh:manual',
      F: 'f.sh:manual',
      G: 'g.sh:manual',
    })
  })

  test('matches the marker tool name in any case', async () => {
    const items = await collect(
      {
        '.claude/settings.json': claude({ Stop: ['~/.claude/hooks/acme.sh'] }),
        '.claude/hooks/acme.sh': '#!/bin/sh\n# Managed by Acme\n',
      },
      { sys: { '/sys/bin/acme': { text: SCRIPT, exec: true } }, path: ['/sys/bin'] },
    )
    expect(items[0]?.category).toBe('manual')
  })

  test('never returns a secret', async () => {
    const items = await collect({
      '.claude/settings.json': claude(
        {
          Stop: [
            `ACME_TOKEN="${TOKEN} x" ~/.claude/hooks/a.sh --key ${TOKEN}`,
            `bash -c "curl -H 'Authorization: ${TOKEN}' https://example.invalid"`,
            `sh -c 'echo ${TOKEN}'`,
          ],
        },
        { statusLine: { command: `node ~/.claude/line.js ${TOKEN}` }, env: { ACME_TOKEN: TOKEN } },
      ),
      '.codex/hooks.json': JSON.stringify({ hooks: { stop: [{ command: `acme-cli --token=${TOKEN}` }] } }),
      '.gitconfig': `[credential]\n\thelper = store --token ${TOKEN}\n[core]\n\thooksPath = ~/.hooks\n`,
    })
    expect(items.length).toBeGreaterThan(3)
    expect(JSON.stringify(items)).not.toContain(TOKEN)
    expect(JSON.stringify(items)).not.toContain('Authorization')
  })

  test('never takes an option value of an interpreter for the script', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.SIGNATUREsecret'
    const url = 'https://hooks.example/T0/B0/abc.def'
    const items = await collect({
      '.claude/settings.json': claude({
        A: [`node --token ${jwt} ~/hooks/n.js`],
        B: [`python3 --url ${url} notify.py`],
        C: [`node --token ${jwt}`],
        D: [`bash -c '${url}'`],
        E: [`env -u ${jwt} ${url} x.sh`],
        F: [`env -C /tmp/${jwt}.dir ~/hooks/n.js`],
      }),
      'hooks/n.js': 'console.log(1)\n',
    })
    const text = JSON.stringify(items)
    expect(text).not.toContain('SIGNATURE')
    expect(text).not.toContain('eyJ')
    expect(text).not.toContain('hooks.example')
    expect(text).not.toContain('abc.def')
    const found = Object.fromEntries(items.map((item) => [item.id.split(':')[2], item.name]))
    expect(found).toEqual({ A: 'n.js', B: 'notify.py', C: 'node', D: 'bash', F: 'n.js' })
  })
})
