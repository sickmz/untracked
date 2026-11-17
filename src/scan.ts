import { collectAnomalies } from './collectors/anomalies'
import { collectBinaries } from './collectors/binaries'
import { collectHome } from './collectors/home'
import { collectHomebrew } from './collectors/homebrew'
import { collectLaunchd } from './collectors/launchd'
import { collectPackages } from './collectors/packages'
import { collectReferences } from './collectors/references'
import { collectServices } from './collectors/services'
import { collectShell } from './collectors/shell'
import { collectSystem } from './collectors/system'
import { diskUsage, measure } from './sizes'
import type { Category, Collector, Context, Item, Kind } from './types'

const COLLECTORS: Collector[] = [
  collectBinaries,
  collectPackages,
  collectShell,
  collectReferences,
  collectHome,
  collectServices,
  collectLaunchd,
  collectSystem,
  collectHomebrew,
  collectAnomalies,
]

export const CATEGORY_ORDER: Category[] = ['manual', 'orphan', 'unclaimed', 'anomaly', 'space', 'installed', 'managed']

// What you run comes first, then what configures it, then where things are.
export const KIND_ORDER: Kind[] = [
  'binary',
  'script',
  'shell_function',
  'shell_alias',
  'service',
  'cron',
  'hook',
  'config',
  'key',
  'repo',
  'dir',
  'shell_env',
  'shell_source',
  'state_dir',
  'package',
  'anomaly',
  'space',
]

// `sizes` also measures disk space, which takes a few seconds on a large home.
export async function scan(ctx: Context, sizes = false): Promise<Item[]> {
  // The home is measured while the collectors run.
  const usage = sizes ? diskUsage(ctx) : null
  const groups = await Promise.all(COLLECTORS.map((collect) => collect(ctx)))
  const items = usage == null ? groups.flat() : await measure(ctx, await usage, groups.flat())
  const seen = new Set<string>()
  for (const item of items) {
    item.id = visible(item.id)
    item.name = visible(item.name)
    item.detail = visible(item.detail)
    if (item.path != null) item.path = visible(item.path)
    if (item.origin != null) item.origin = visible(item.origin)
    if (seen.has(item.id)) throw new Error(`two collectors returned the same item id: ${item.id}`)
    seen.add(item.id)
  }
  return items.sort(compare)
}

// A file name can hold control characters, which a terminal would obey. They are shown as text.
function visible(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

export function compare(a: Item, b: Item): number {
  const by_category = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  if (by_category !== 0) return by_category
  if (a.kind !== b.kind) return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}
