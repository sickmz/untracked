import { CATEGORY_ORDER } from '../scan'
import type { Item, Kind, Notes } from '../types'
import { formatSize, HEADINGS, KIND_NAMES } from './text'

// The inventory as a document to keep. `date` is "YYYY-MM-DD".
export function renderMarkdown(items: Item[], notes: Notes, date: string): string {
  const lines = ['# Machine inventory', '', `Taken on ${date}.`, '']
  for (const category of CATEGORY_ORDER) {
    const found = items.filter((item) => item.category === category)
    if (found.length === 0) continue
    // The same order as the terminal report: largest first where nothing else orders the list.
    const by_size = category === 'unclaimed' || category === 'anomaly' || category === 'space'
    const in_category = by_size ? [...found].sort((a, b) => (b.size ?? -1) - (a.size ?? -1)) : found
    lines.push(`## ${HEADINGS[category]}`, '')
    const compact = category === 'installed' || category === 'managed'
    for (const [kind, group] of groupKind(in_category)) {
      if (compact) {
        lines.push(`- ${KIND_NAMES[kind]}: ${group.map((item) => item.name).join(', ')}`)
        continue
      }
      if (kind !== 'anomaly' && kind !== 'space') lines.push(`### ${KIND_NAMES[kind]}`, '')
      if (kind === 'package') lines.push(...packageLines(group, notes))
      else for (const item of group) lines.push(itemLine(item, notes))
      lines.push('')
    }
    if (compact) lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

// One line per package manager. A package with a note keeps a line of its own.
function packageLines(items: Item[], notes: Notes): string[] {
  const managers = new Map<string, string[]>()
  const noted: string[] = []
  for (const item of items) {
    if (notes[item.id] != null) {
      noted.push(itemLine(item, notes))
      continue
    }
    const manager = item.origin?.split(':')[0] ?? 'other'
    managers.set(manager, [...(managers.get(manager) ?? []), item.name])
  }
  const lines = [...managers].map(([manager, names]) => `- ${manager}: ${names.join(', ')}`)
  return [...lines, ...noted]
}

function itemLine(item: Item, notes: Notes): string {
  let line = `- **${item.name}**`
  if (item.path != null && item.path !== item.name) line += ` \`${item.path}\``
  if (item.size != null) line += ` (${formatSize(item.size)})`
  if (item.detail !== '') line += `: ${item.detail}`
  const note = notes[item.id]
  if (note != null) line += ` *Note: ${note}*`
  return line
}

function groupKind(items: Item[]): Map<Kind, Item[]> {
  const groups = new Map<Kind, Item[]>()
  for (const item of items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item])
  return groups
}
