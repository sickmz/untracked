import { expect, test } from 'bun:test'
import { compare } from '../src/diff'
import { renderMarkdown } from '../src/render/markdown'
import { renderDiff, renderScan } from '../src/render/text'
import type { Item } from '../src/types'

// Builds an item for tests. Only the fields a test cares about need to be given.
function makeItem(fields: Partial<Item> & { id: string }): Item {
  const [kind, key] = fields.id.split(/:(.*)/s) as [Item['kind'], string]
  const item: Item = {
    kind,
    category: 'manual',
    name: key.split('/').pop() ?? key,
    detail: 'Written by hand.',
    fingerprint: 'aaaa',
    ...fields,
  }
  return item
}

const script = makeItem({
  id: 'script:~/tools/fetch-logs',
  name: 'fetch-logs',
  path: '~/tools/fetch-logs',
  detail: 'Script you wrote, on your PATH.',
})
const alias = makeItem({ id: 'shell_alias:ll', name: 'll', detail: 'Alias in ~/.bashrc.' })
const orphan = makeItem({
  id: 'config:~/.config/acme-cli',
  category: 'orphan',
  name: 'acme-cli',
  path: '~/.config/acme-cli',
  detail: 'Config of acme-cli, which is not installed.',
})
const crowded = makeItem({
  id: 'anomaly:~/Downloads',
  kind: 'anomaly',
  category: 'anomaly',
  name: 'Downloads',
  path: '~/Downloads',
  detail: '4,210 files.',
  fingerprint: '',
})
const tool = makeItem({
  id: 'binary:~/.local/bin/acme',
  category: 'installed',
  name: 'acme',
  path: '~/.local/bin/acme',
  detail: 'Put there by the acme installer.',
  fingerprint: '',
})
const jq = makeItem({
  id: 'package:dpkg:jq',
  category: 'managed',
  name: 'jq',
  origin: 'dpkg:jq',
  detail: 'Debian package.',
  fingerprint: '',
})
const ripgrep = makeItem({ ...jq, id: 'package:dpkg:ripgrep', name: 'ripgrep' })
const items: Item[] = [script, alias, orphan, crowded, tool, jq, ripgrep]
const notes = { [script.id]: 'needs the acme token' }

test('scan text has plain headings, kinds and a note line', () => {
  const text = renderScan(items, notes, false, false)
  expect(text).toBe(
    [
      'Put there by hand (2)',
      '  Scripts  ~/tools/fetch-logs  Script you wrote, on your PATH.',
      '           note: needs the acme token',
      '  Aliases  ll                  Alias in ~/.bashrc.',
      '',
      'Left behind (1)',
      '  Config files  ~/.config/acme-cli  Config of acme-cli, which is not installed.',
      '',
      'Worth a look (1)',
      '  4,210 files.  ~/Downloads',
      '',
      'Not shown: 1 installed by their own installer, 2 from a package manager. Use --all to list them.',
    ].join('\n'),
  )
})

test('scan text with all lists installed and managed items', () => {
  const text = renderScan(items, notes, true, false)
  expect(text).toContain('Installed by their own installer (1)\n  Programs  ~/.local/bin/acme')
  expect(text).toContain('From a package manager (2)\n  Packages  dpkg: jq, ripgrep')
  expect(text).not.toContain('Not shown')
})

test('empty sections are not printed', () => {
  const text = renderScan([script], {}, false, false)
  expect(text).not.toContain('Left behind')
  expect(text).not.toContain('Not shown')
})

test('color marks headings, labels and markers', () => {
  const text = renderScan([script], {}, false, true)
  expect(text).toContain('\x1b[1mPut there by hand\x1b[0m')
  expect(text).toContain('\x1b[2mScripts  \x1b[0m~/tools/fetch-logs')
  const diff = renderDiff(compare([], [script]), '2026-01-02T03:04:05.000Z', true)
  expect(diff).toContain('\x1b[32m+\x1b[0m \x1b[2mScripts  \x1b[0m~/tools/fetch-logs')
})

test('diff text marks each change', () => {
  const edited = { ...alias, fingerprint: 'new' }
  const moved = { ...orphan, category: 'manual' as const }
  const changes = compare([alias, orphan, jq], [script, edited, moved])
  const text = renderDiff(changes, '2026-01-02T03:04:05.000Z', false)
  expect(text).toContain('+ Scripts       ~/tools/fetch-logs  Script you wrote, on your PATH.')
  expect(text).toContain('~ Aliases       ll                  Alias in ~/.bashrc.')
  expect(text).toContain('~ Config files  ~/.config/acme-cli  Config of acme-cli, which is not installed., was: left behind')
  expect(text).toContain('From a package manager (1)\n- Packages  jq  Debian package.')
  expect(text).toEndWith('1 added, 1 removed, 2 changed since 2026-01-02 03:04 UTC.')
})

test('diff text with no change names the snapshot date', () => {
  expect(renderDiff([], '2026-01-02T03:04:05.000Z', false)).toBe('Nothing changed since 2026-01-02 03:04 UTC.')
})

test('markdown export has sections and notes, and no rebuild part', () => {
  const markdown = renderMarkdown(items, notes, '2026-01-02')
  expect(markdown).toStartWith('# Machine inventory\n\nTaken on 2026-01-02.\n\n## Put there by hand\n\n### Scripts\n\n')
  expect(markdown).toContain('- **fetch-logs** `~/tools/fetch-logs`: Script you wrote, on your PATH. *Note: needs the acme token*')
  expect(markdown).toContain('## Left behind')
  expect(markdown).toContain('## Worth a look')
  expect(markdown).toContain('## Installed by their own installer\n\n- Programs: acme\n')
  expect(markdown).toContain('## From a package manager\n\n- Packages: jq, ripgrep\n')
  expect(markdown).not.toContain('Rebuild')
  expect(markdown).not.toContain('Copy by hand')
  expect(markdown).toEndWith('\n')
})

test('columns line up and a long line is cut at the terminal width', () => {
  const long_item = makeItem({ id: 'script:~/tools/sync-photos', path: '~/tools/sync-photos', detail: 'x'.repeat(200) })
  const lines = renderScan([script, long_item], {}, false, false, 70).split('\n')
  expect(lines[1]).toBe('  Scripts  ~/tools/fetch-logs   Script you wrote, on your PATH.')
  expect(lines[2]).toHaveLength(70)
  expect(lines[2]).toStartWith('           ~/tools/sync-photos  xxx')
  expect(lines[2]).toEndWith('…')
})

test('sizes sit in their own column, and unclaimed directories go largest first', () => {
  const big = makeItem({ id: 'state_dir:~/.acme', kind: 'state_dir', category: 'unclaimed', name: '.acme', path: '~/.acme', detail: '', size: 3 * 1024 ** 3 })
  const mid = makeItem({ id: 'state_dir:~/.orbit', kind: 'state_dir', category: 'unclaimed', name: '.orbit', path: '~/.orbit', detail: '', size: 20 * 1024 ** 2 })
  const tiny = makeItem({ id: 'state_dir:~/.nano', kind: 'state_dir', category: 'unclaimed', name: '.nano', path: '~/.nano', detail: '', size: 4096 })
  const tool = makeItem({ id: 'binary:~/tools/sync', kind: 'binary', name: 'sync', path: '~/tools/sync', detail: 'link to ~/x', size: 92 * 1024 ** 2 })
  const text = renderScan([tool, script, tiny, mid, big], {}, false, false)
  expect(text).toContain('  Programs  ~/tools/sync        92 MB  link to ~/x')
  expect(text).toContain('  Scripts   ~/tools/fetch-logs         Script you wrote, on your PATH.')
  expect(text).toContain(
    ['Unclaimed directories (3)', '  No installed program matches these.', '  ~/.acme   3.0 GB', '  ~/.orbit   20 MB', '  Smaller than 1 MB: ~/.nano'].join('\n'),
  )
})

test('no line is longer than the width or ends in spaces', () => {
  const long_name = makeItem({ id: `dir:/opt/${'a'.repeat(90)}`, kind: 'dir', name: `/opt/${'a'.repeat(90)}`, path: `/opt/${'a'.repeat(90)}`, detail: '' })
  const packages = Array.from({ length: 30 }, (_unused, index) =>
    makeItem({ id: `package:apt:tool-${index}`, kind: 'package', name: `tool-${index}`, origin: `apt:tool-${index}`, detail: 'apt package' }),
  )
  const sized = makeItem({ id: 'binary:~/tools/sync', kind: 'binary', name: 'sync', path: '~/tools/sync', detail: 'x'.repeat(80), size: 4096 })
  for (const width of [40, 60, 100]) {
    const lines = renderScan([sized, script, long_name, ...packages], {}, false, false, width).split('\n')
    expect(lines.filter((line) => line.length > width)).toEqual([])
    expect(lines.filter((line) => line !== line.trimEnd())).toEqual([])
  }
  const text = renderScan(packages, {}, false, false, 40)
  for (let index = 0; index < 30; index++) expect(text).toContain(`tool-${index}`)
})
