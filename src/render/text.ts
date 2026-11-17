import { CATEGORY_ORDER } from '../scan'
import type { Category, Change, Item, Kind, Notes } from '../types'

export const HEADINGS: Record<Category, string> = {
  manual: 'Put there by hand',
  orphan: 'Left behind',
  unclaimed: 'Unclaimed directories',
  anomaly: 'Worth a look',
  space: 'Where the space is',
  installed: 'Installed by their own installer',
  managed: 'From a package manager',
}

export const KIND_NAMES: Record<Kind, string> = {
  binary: 'Programs',
  script: 'Scripts',
  shell_function: 'Functions',
  shell_alias: 'Aliases',
  shell_env: 'Variables',
  shell_source: 'Sourced files',
  config: 'Config files',
  key: 'SSH keys',
  hook: 'Hooks',
  service: 'Services',
  cron: 'Cron jobs',
  repo: 'Checkouts',
  dir: 'Directories',
  state_dir: 'Program state',
  package: 'Packages',
  anomaly: 'Oddities',
  space: 'Space',
}

const MARKERS: Record<Change['type'], string> = { added: '+', removed: '-', changed: '~' }
const MARKER_COLORS: Record<Change['type'], string> = { added: '32', removed: '31', changed: '33' }
const BOLD = '1'
const DIM = '2'
// A name longer than this does not widen the name column for everyone else.
const NAME_CAP = 44
const WRAP_WIDTH = 100
const GAP = '  '
const MEGABYTE = 1024 ** 2
const GIGABYTE = 1024 ** 3
// Where the biggest come first: what has no other order to follow.
const BY_SIZE: Category[] = ['unclaimed', 'anomaly', 'space']

type Line = { item: Item; marker?: Change['type']; extra?: string }

// One line of the report, as the three columns it is printed in.
type Row = { marker?: Change['type']; label: string; name: string; size: string; detail: string; note?: string }

type Style = { color: boolean; width: number }

// `width` is the terminal width: longer lines are cut. Leave it out to print lines in full.
export function renderScan(items: Item[], notes: Notes, all: boolean, color: boolean, width = Infinity): string {
  const shown = all ? items : items.filter((item) => !hidden(item.category))
  const lines = sections(
    shown.map((item) => ({ item })),
    notes,
    { color, width },
  )
  if (shown.length === 0) lines.push('Nothing to report.')
  const footer = hiddenLine(items, all)
  if (footer != null) lines.push(paint(footer, DIM, color))
  return lines.join('\n')
}

export function renderDiff(changes: Change[], taken_at: string, color: boolean, width = Infinity): string {
  if (changes.length === 0) return `Nothing changed since ${formatDate(taken_at)}.`
  const lines = sections(
    changes.map((change) => {
      const line: Line = { item: change.item, marker: change.type }
      if (change.before != null && change.before.category !== change.item.category) {
        line.extra = `was: ${HEADINGS[change.before.category].toLowerCase()}`
      }
      return line
    }),
    {},
    { color, width },
  )
  lines.push(`${summary(changes)} since ${formatDate(taken_at)}.`)
  return lines.join('\n')
}

// 16.0 GB, 92 MB, 340 KB.
export function formatSize(bytes: number): string {
  if (bytes >= GIGABYTE) return `${(bytes / GIGABYTE).toFixed(1)} GB`
  if (bytes >= MEGABYTE) return `${Math.round(bytes / MEGABYTE)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// "2026-11-17T09:05:00.000Z" becomes "2026-11-17 09:05 UTC".
export function formatDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function hidden(category: Category): boolean {
  return category === 'installed' || category === 'managed'
}

function sections(lines: Line[], notes: Notes, style: Style): string[] {
  const out: string[] = []
  for (const category of CATEGORY_ORDER) {
    const found = lines.filter((line) => line.item.category === category)
    if (found.length === 0) continue
    const in_category = BY_SIZE.includes(category) ? bySize(found) : found
    out.push(`${paint(HEADINGS[category], BOLD, style.color)} ${paint(`(${in_category.length})`, DIM, style.color)}`)
    if (category === 'unclaimed' && in_category.every((line) => line.marker == null)) {
      out.push(...unclaimedLines(in_category, notes, style), '')
      continue
    }
    out.push(...table(rows(in_category, notes, style), style), '')
  }
  return out
}

// Largest first. What was not measured keeps its order, after the rest.
function bySize(lines: Line[]): Line[] {
  return [...lines].sort((a, b) => (b.item.size ?? -1) - (a.item.size ?? -1))
}

// The kind is printed once, on the first row of its group.
function rows(lines: Line[], notes: Notes, style: Style): Row[] {
  const label_width = Math.max(...lines.map((line) => KIND_NAMES[line.item.kind].length))
  const listed = lines.filter((line) => isListed(line, notes))
  const out: Row[] = []
  let last: Kind | null = null
  for (const line of lines) {
    if (listed.includes(line)) continue
    const row = toRow(line, notes)
    if (line.item.kind === last) row.label = ''
    last = line.item.kind
    out.push(row)
  }
  const width = Math.min(style.width, WRAP_WIDTH) - 4 - label_width
  const packages = packageRows(listed, width)
  if (last === 'package' && packages[0] != null) packages[0].label = ''
  return [...out, ...packages]
}

// Packages say nothing beyond their name, so each manager's packages share a few lines.
// One with a note, or one that changed in a diff, keeps a line of its own.
function isListed(line: Line, notes: Notes): boolean {
  return line.item.kind === 'package' && line.marker == null && notes[line.item.id] == null
}

function packageRows(lines: Line[], width: number): Row[] {
  const managers = new Map<string, string[]>()
  for (const { item } of lines) {
    const manager = item.origin?.split(':')[0] ?? 'other'
    managers.set(manager, [...(managers.get(manager) ?? []), item.name])
  }
  const out: Row[] = []
  for (const [manager, names] of managers) {
    const wrapped = wrap(names, width - manager.length - 2)
    wrapped.forEach((text, index) => {
      const prefix = index === 0 ? `${manager}: ` : ' '.repeat(manager.length + 2)
      out.push({ label: out.length === 0 ? KIND_NAMES.package : '', name: `${prefix}${text}`, size: '', detail: '' })
    })
  }
  return out
}

function toRow(line: Line, notes: Notes): Row {
  const { item } = line
  const row: Row = { label: KIND_NAMES[item.kind], name: item.name, size: '', detail: item.detail }
  if (item.size != null) row.size = formatSize(item.size)
  if (item.kind === 'space' || item.category === 'unclaimed') row.label = ''
  if (item.kind === 'anomaly') {
    // What is odd comes first, where it is second.
    row.label = ''
    row.name = item.detail
    row.detail = item.path ?? ''
  } else if (item.kind === 'service' || item.kind === 'package') {
    // The name says it all: the path is always the same folder.
  } else if (item.path != null && (item.path === `~/${item.name}` || item.path.endsWith(`/${item.name}`))) {
    // A path that ends with the name stands in for it.
    row.name = item.path
  } else if (item.path != null && item.path !== item.name && !item.detail.includes(item.path)) {
    row.detail = item.detail === '' ? item.path : `${item.path}${GAP}${item.detail}`
  }
  if (line.extra != null) row.detail = row.detail === '' ? line.extra : `${row.detail}, ${line.extra}`
  if (line.marker != null) row.marker = line.marker
  const note = notes[item.id]
  if (note != null) row.note = note
  return row
}

function table(all_rows: Row[], style: Style): string[] {
  const label_width = Math.max(...all_rows.map((row) => row.label.length))
  // Only rows with something after the name set the width of the name column.
  const followed = all_rows.filter((row) => row.size !== '' || row.detail !== '')
  const name_width = Math.max(0, ...followed.map((row) => row.name.length).filter((length) => length <= NAME_CAP))
  const size_width = Math.max(...all_rows.map((row) => row.size.length))
  const out: string[] = []
  for (const row of all_rows) {
    const marker = row.marker == null ? ' ' : paint(MARKERS[row.marker], MARKER_COLORS[row.marker], style.color)
    const label = label_width === 0 ? '' : `${row.label.padEnd(label_width)}${GAP}`
    const name = fit(row.name, style.width - 2 - label.length) || row.name
    const padded = name.padEnd(name_width)
    const size = size_width === 0 ? '' : `${GAP}${row.size.padStart(size_width)}`
    const detail = fit(row.detail, style.width - 2 - label.length - padded.length - size.length - GAP.length)
    // Nothing is padded when nothing follows, so a line never ends in spaces.
    let text = `${marker} ${paint(label, DIM, style.color)}`
    if (detail !== '') text += `${padded}${size}${GAP}${paint(detail, DIM, style.color)}`
    else if (row.size !== '') text += `${padded}${size}`
    else text += name
    out.push(text)
    if (row.note != null) out.push(`${' '.repeat(2 + label.length)}note: ${row.note}`)
  }
  return out
}

// The text, cut with "…" when it does not fit. '' when there is no room for it at all.
function fit(text: string, room: number): string {
  if (text.length <= room) return text
  if (room < 4) return ''
  return `${text.slice(0, room - 1)}…`
}

// Unclaimed directories all say the same thing. The ones that take real space get a row each,
// largest first; the small ones share a few lines. One with a note always gets a row.
function unclaimedLines(lines: Line[], notes: Notes, style: Style): string[] {
  const out = [paint('  No installed program matches these.', DIM, style.color)]
  const big = lines.filter((line) => (line.item.size ?? 0) >= MEGABYTE || notes[line.item.id] != null)
  const small = lines.filter((line) => !big.includes(line))
  if (big.length > 0) out.push(...table(big.map((line) => toRow(line, notes)), style))
  if (small.length === 0) return out
  const intro = big.length === 0 ? '' : 'Smaller than 1 MB: '
  const width = Math.min(style.width, WRAP_WIDTH) - 2
  const wrapped = wrap(small.map((line) => line.item.path ?? line.item.name), width - intro.length)
  wrapped.forEach((text, index) => out.push(`  ${index === 0 ? intro : ' '.repeat(intro.length)}${text}`))
  return out
}

function wrap(words: string[], width: number): string[] {
  const out: string[] = []
  let current = ''
  for (const word of words) {
    // One character is kept for the comma that ends a wrapped line.
    if (current !== '' && current.length + word.length + 3 > width) {
      out.push(`${current},`)
      current = ''
    }
    current = current === '' ? word : `${current}, ${word}`
  }
  if (current !== '') out.push(current)
  return out
}

function hiddenLine(items: Item[], all: boolean): string | null {
  if (all) return null
  const installed = items.filter((item) => item.category === 'installed').length
  const managed = items.filter((item) => item.category === 'managed').length
  const parts: string[] = []
  if (installed > 0) parts.push(`${installed} installed by their own installer`)
  if (managed > 0) parts.push(`${managed} from a package manager`)
  if (parts.length === 0) return null
  return `Not shown: ${parts.join(', ')}. Use --all to list them.`
}

function summary(changes: Change[]): string {
  const parts: string[] = []
  for (const type of ['added', 'removed', 'changed'] as const) {
    const count = changes.filter((change) => change.type === type).length
    if (count > 0) parts.push(`${count} ${type}`)
  }
  return parts.join(', ')
}

function paint(text: string, code: string, color: boolean): string {
  if (!color || text === '') return text
  return `\x1b[${code}m${text}\x1b[0m`
}
