import { expect, test } from 'bun:test'
import { compare } from '../src/diff'
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

const script = makeItem({ id: 'script:~/tools/fetch-logs', path: '~/tools/fetch-logs' })
const alias = makeItem({ id: 'shell_alias:ll', fingerprint: 'bbbb' })
const pkg = makeItem({ id: 'package:npm:acme-cli', category: 'managed', fingerprint: '' })

test('nothing changed gives no changes', () => {
  expect(compare([script, alias], [alias, script])).toEqual([])
})

test('added and removed items', () => {
  const changes = compare([script], [alias])
  expect(changes).toEqual([
    { type: 'removed', item: script },
    { type: 'added', item: alias },
  ])
})

test('a new fingerprint is a change', () => {
  const edited = { ...script, fingerprint: 'cccc' }
  expect(compare([script], [edited])).toEqual([{ type: 'changed', item: edited, before: script }])
})

test('a new category is a change', () => {
  const orphan = { ...script, category: 'orphan' as const }
  expect(compare([script], [orphan])).toEqual([{ type: 'changed', item: orphan, before: script }])
})

test('anomalies are ignored on both sides', () => {
  const crowded = makeItem({ id: 'anomaly:~/Downloads', category: 'anomaly', fingerprint: '' })
  const zombies = makeItem({ id: 'anomaly:zombies', category: 'anomaly', fingerprint: '' })
  expect(compare([crowded, script], [script, zombies])).toEqual([])
  expect(compare([crowded], [{ ...crowded, detail: 'other', fingerprint: 'x' }])).toEqual([])
})

test('changes are sorted like a scan', () => {
  const changes = compare([], [pkg, alias, script])
  expect(changes.map((change) => change.item.id)).toEqual([script.id, alias.id, pkg.id])
})
