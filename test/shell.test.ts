import { afterEach, describe, expect, test } from 'bun:test'
import { collectShell } from '../src/collectors/shell'
import type { Item } from '../src/types'
import { type Fixture, type FixtureOptions, makeHome, type Tree } from './fixture'

const TOKEN = 'tok_9f8e7d6c5b4a3210fake'
const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

async function collect(tree: Tree, options: FixtureOptions = {}): Promise<{ fixture: Fixture; items: Item[] }> {
  const fixture = await makeHome(tree, options)
  fixtures.push(fixture)
  return { fixture, items: await collectShell(fixture.ctx) }
}

function byId(items: Item[], id: string): Item | undefined {
  return items.find((item) => item.id === id)
}

describe('collectShell', () => {
  test('drops lines that match the default dotfile', async () => {
    const skel = "HISTSIZE=1000\nalias ll='ls -alF'\nif [ -f ~/.bash_aliases ]; then\n    . ~/.bash_aliases\nfi\n"
    const { items } = await collect(
      { '.bashrc': `${skel}alias gs='git status'\n` },
      { skel: { '.bashrc': skel } },
    )
    expect(items.map((item) => item.id)).toEqual(['shell_alias:gs'])
  })

  test('counts a file with no default in full', async () => {
    const { items } = await collect({ '.zshrc': 'HISTSIZE=1000\n' }, { skel: { '.bashrc': 'HISTSIZE=1000\n' } })
    expect(items.map((item) => item.id)).toEqual(['shell_env:~/.zshrc:HISTSIZE'])
  })

  test('reports a multi-line function and fingerprints its body', async () => {
    const body = 'deploy_stage() {\n  local target="$1"\n  if [ -n "$target" ]; then\n    echo "${target}"\n  fi\n}\n'
    const { items } = await collect({ '.bashrc': `${body}export AFTER=1\n` }, { skel: { '.bashrc': 'fi\n}\n' } })
    const fn = byId(items, 'shell_function:deploy_stage')
    expect(fn).toMatchObject({
      kind: 'shell_function',
      category: 'manual',
      name: 'deploy_stage',
      detail: '',
      path: '~/.bashrc',
    })
    expect(fn?.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(byId(items, 'shell_env:~/.bashrc:AFTER')).toBeDefined()

    const same = await collect({ '.bashrc': `# moved\n\n${body}` })
    expect(byId(same.items, 'shell_function:deploy_stage')?.fingerprint).toBe(fn?.fingerprint as string)

    const edited = await collect({ '.bashrc': body.replace('echo', 'printf') })
    expect(byId(edited.items, 'shell_function:deploy_stage')?.fingerprint).not.toBe(fn?.fingerprint as string)
  })

  test('recognizes the other function forms', async () => {
    const { items } = await collect({
      '.zshrc': 'function acme_up {\n  echo up\n}\nacme_down()\n{\n  echo down\n}\nquick() { echo hi; }\n',
    })
    expect(items.map((item) => item.id).sort()).toEqual([
      'shell_function:acme_down',
      'shell_function:acme_up',
      'shell_function:quick',
    ])
  })

  test('drops a default function but keeps one the user edited', async () => {
    const default_fn = 'greet() {\n  echo hello\n}\n'
    const unchanged = await collect({ '.bashrc': default_fn }, { skel: { '.bashrc': default_fn } })
    expect(unchanged.items).toEqual([])
    const edited = await collect({ '.bashrc': 'greet() {\n  echo bye\n}\n' }, { skel: { '.bashrc': default_fn } })
    expect(edited.items.map((item) => item.id)).toEqual(['shell_function:greet'])
  })

  test('reports aliases with a definition fingerprint', async () => {
    const { items } = await collect({ '.bash_aliases': "alias gs='git status' gl=\"git log\"\nalias k=kubectl\n" })
    expect(items.map((item) => item.id).sort()).toEqual(['shell_alias:gl', 'shell_alias:gs', 'shell_alias:k'])
    const gs = byId(items, 'shell_alias:gs')
    expect(gs).toMatchObject({ kind: 'shell_alias', category: 'manual', detail: '' })
    expect(gs?.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(gs?.fingerprint).not.toBe(byId(items, 'shell_alias:gl')?.fingerprint as string)
  })

  test('reports variables by name only, once per file', async () => {
    const { items } = await collect({
      '.profile': 'export PATH="$HOME/bin:$PATH"\nPATH="$HOME/.local/bin:$PATH"\nexport EDITOR=vim PAGER=less\nFOO=1 make build\n',
    })
    const env = items.filter((item) => item.kind === 'shell_env')
    expect(env.map((item) => item.id).sort()).toEqual([
      'shell_env:~/.profile:EDITOR',
      'shell_env:~/.profile:PAGER',
      'shell_env:~/.profile:PATH',
    ])
    for (const item of env) {
      expect(item.fingerprint).toBe('')
      expect(item.detail).toBe('')
    }
    expect(JSON.stringify(items)).not.toContain('vim')
  })

  test('marks a guarded source of a missing file as orphan', async () => {
    const { items } = await collect({
      '.bashrc': 'export ACME_DIR="$HOME/.acme"\n[ -s "$ACME_DIR/acme.sh" ] && \\. "$ACME_DIR/acme.sh"\n',
    })
    const source = items.find((item) => item.kind === 'shell_source')
    expect(source).toMatchObject({
      category: 'orphan',
      name: '$ACME_DIR/acme.sh',
      detail: 'the file is missing',
      path: '~/.bashrc',
      fingerprint: '',
    })
  })

  test('marks a guarded source of an existing file as manual', async () => {
    const { items } = await collect({
      '.zshrc': 'if [ -f ~/.acme/env.sh ]; then source ~/.acme/env.sh; fi\n',
      '.acme/env.sh': 'true\n',
    })
    expect(items.find((item) => item.kind === 'shell_source')).toMatchObject({
      id: 'shell_source:~/.zshrc:file:~/.acme/env.sh',
      category: 'manual',
      name: '~/.acme/env.sh',
    })
  })

  test('keeps an unresolvable source manual', async () => {
    const { items } = await collect({
      '.bashrc': [
        '. "$UNKNOWN_DIR/x.sh"',
        'source ~/.bashrc.d/*.sh',
        '. relative.sh',
        'if [ -d /a ]; then ACME_DIR=/a; else ACME_DIR=/b; fi',
        '. "$ACME_DIR/env.sh"',
        'eval "$(command -v acme-cli)"',
      ].join('\n'),
    })
    const sources = items.filter((item) => item.kind === 'shell_source')
    expect(sources).toHaveLength(4)
    for (const item of sources) expect(item.category).toBe('manual')
  })

  test('marks an eval of a missing tool as orphan and an installed one as manual', async () => {
    const { items } = await collect(
      { '.bashrc': 'eval "$(acme-cli init bash)"\neval "$(zoxide init bash)"\nsource <(kubectl completion bash)\n' },
      { sys: { '/sys/bin/zoxide': { text: '#!/bin/sh\n', exec: true } }, path: ['/sys/bin'] },
    )
    expect(byId(items, 'shell_source:~/.bashrc:run:acme-cli')).toMatchObject({
      category: 'orphan',
      name: 'acme-cli',
      detail: 'runs at startup, but is not installed',
    })
    expect(byId(items, 'shell_source:~/.bashrc:run:zoxide')?.category).toBe('manual')
    expect(byId(items, 'shell_source:~/.bashrc:run:kubectl')?.category).toBe('orphan')
  })

  test('keeps ids unique when two files define the same things', async () => {
    const text = 'greet() {\n  echo hi\n}\nalias gs="git status"\nsource ~/.shared.sh\nexport EDITOR=vim\n'
    const { items } = await collect({ '.bashrc': text, '.zshrc': text, '.shared.sh': '' })
    const ids = items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('shell_function:greet')
    expect(ids).toContain('shell_function:~/.zshrc:greet')
    expect(ids).toContain('shell_alias:gs')
    expect(ids).toContain('shell_alias:~/.zshrc:gs')
  })

  test('never returns a secret', async () => {
    const { items } = await collect({
      '.bashrc': [
        `export API_TOKEN=${TOKEN}`,
        `SECRET="${TOKEN}"`,
        `alias pushit='curl -H "Authorization: ${TOKEN}" https://example.invalid'`,
        'call_api() {',
        `  curl -H "X-Key: ${TOKEN}" https://example.invalid`,
        '}',
        `eval "$(acme-cli init --key ${TOKEN})"`,
        `source "$(acme-cli prefix --key ${TOKEN})/env.sh"`,
        `source <(acme-cli completion --key ${TOKEN})`,
        `. \`acme-cli path ${TOKEN}\``,
      ].join('\n'),
    })
    expect(items.length).toBeGreaterThan(5)
    expect(JSON.stringify(items)).not.toContain(TOKEN)
    expect(JSON.stringify(items)).not.toContain('Authorization')
  })

  test('never parses a multi-line quoted value or a heredoc body as commands', async () => {
    const { items } = await collect({
      '.bashrc': [
        'export CERT="-----BEGIN CERTIFICATE-----',
        'MIIBfakefakefakeBODY',
        'QUJDRAzzSECRET==',
        '-----END CERTIFICATE-----"',
        "NOTE='first line",
        'alias quotedfake=x',
        "last line'",
        'cat > ~/.netrc <<END',
        'source /opt/secret/ghp_TOKENINPATH',
        'alias deploytoken=ghp_fakeHEREDOC',
        'password=hunter2SECRET',
        'END',
        'cat <<-\'EOF\' > /dev/null',
        '\talias tabbedfake=x',
        '\tEOF',
        'cat <<"DOC"',
        'export QUOTEDDOC=1',
        'DOC',
        'after_doc() {',
        '  echo done',
        '}',
        'echo $((1 << 2))',
        'export LONG=a \\',
        '  b',
        'alias gs="git status"',
      ].join('\n'),
    })
    const text = JSON.stringify(items)
    for (const secret of ['QUJDRAzzSECRET', 'MIIBfake', 'ghp_', 'TOKENINPATH', 'hunter2SECRET', 'deploytoken', 'password']) {
      expect(text).not.toContain(secret)
    }
    expect(items.map((item) => item.id).sort()).toEqual([
      'shell_alias:gs',
      'shell_env:~/.bashrc:CERT',
      'shell_env:~/.bashrc:LONG',
      'shell_env:~/.bashrc:NOTE',
      'shell_function:after_doc',
    ])
  })

  test('fingerprints a heredoc inside a function', async () => {
    const body = (line: string) => `usage() {\n  cat <<EOF\n${line}\nEOF\n}\nexport AFTER=1\n`
    const first = await collect({ '.bashrc': body('usage: run') })
    const second = await collect({ '.bashrc': body('usage: run now') })
    expect(byId(first.items, 'shell_env:~/.bashrc:AFTER')).toBeDefined()
    expect(byId(first.items, 'shell_function:usage')?.fingerprint).not.toBe(
      byId(second.items, 'shell_function:usage')?.fingerprint as string,
    )
  })

  test('ignores braces inside quotes and comments when finding the end of a function', async () => {
    const { items } = await collect({
      '.bashrc': [
        'greet() {',
        '  echo "{"',
        "  echo '{'",
        '  echo \\{ # {',
        '}',
        "alias ll='ls -l'",
        'export EDITOR=vim',
      ].join('\n'),
    })
    expect(items.map((item) => item.id).sort()).toEqual([
      'shell_alias:ll',
      'shell_env:~/.bashrc:EDITOR',
      'shell_function:greet',
    ])
  })

  test('reads a customised .bash_logout and drops the default one', async () => {
    const skel = 'if [ "$SHLVL" = 1 ]; then\n    clear\nfi\n'
    const custom = await collect(
      { '.bash_logout': `${skel}alias bye=exit\n` },
      { skel: { '.bash_logout': skel } },
    )
    expect(custom.items.map((item) => item.id)).toEqual(['shell_alias:bye'])
    expect(custom.items[0]?.path).toBe('~/.bash_logout')
    const plain = await collect({ '.bash_logout': skel }, { skel: { '.bash_logout': skel } })
    expect(plain.items).toEqual([])
  })

  test('keeps quote state right after ANSI-C quotes and multi-line one-line functions', async () => {
    const { items } = await collect({
      '.bashrc': [
        "echo $'it\\'s'",
        'password=hunter2SECRET',
        'banner() { echo "top',
        'bottom"; }',
        'export AFTER=1',
      ].join('\n'),
    })
    expect(JSON.stringify(items)).not.toContain('hunter2SECRET')
    expect(items.map((item) => item.id).sort()).toEqual([
      'shell_env:~/.bashrc:AFTER',
      'shell_env:~/.bashrc:password',
      'shell_function:banner',
    ])
  })
})
