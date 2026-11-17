import { compare as order } from './scan'
import type { Change, Item } from './types'

// What changed between two item lists. Anomalies and space are never compared: they move on their own.
export function compare(before: Item[], after: Item[]): Change[] {
  const old_items = byId(before)
  const new_items = byId(after)
  const changes: Change[] = []
  for (const [id, item] of new_items) {
    const old = old_items.get(id)
    if (old == null) {
      changes.push({ type: 'added', item })
      continue
    }
    if (old.fingerprint === item.fingerprint && old.category === item.category) continue
    changes.push({ type: 'changed', item, before: old })
  }
  for (const [id, item] of old_items) {
    if (!new_items.has(id)) changes.push({ type: 'removed', item })
  }
  return changes.sort((a, b) => order(a.item, b.item))
}

function byId(items: Item[]): Map<string, Item> {
  const compared = items.filter((item) => item.category !== 'anomaly' && item.category !== 'space')
  return new Map(compared.map((item) => [item.id, item]))
}
