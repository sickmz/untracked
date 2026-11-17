import { join } from 'node:path'
import { listDir, readHead } from '../lib/fs'
import type { Context, Item } from '../types'

// Where Homebrew lives: Apple silicon, Intel Macs, Linux.
const PREFIXES = ['opt/homebrew', 'usr/local', 'home/linuxbrew/.linuxbrew']
const RECEIPT_LIMIT = 1024 * 1024
// What Homebrew accepts as a formula or cask name.
const BREW_NAME = /^[a-z0-9][a-z0-9+_.@-]*$/

// Formulae installed by an explicit `brew install`, and casks, read from Homebrew's own files.
// Formulae pulled in as dependencies are left out.
export async function collectHomebrew(ctx: Context): Promise<Item[]> {
  if (ctx.root == null) return []
  const items = new Map<string, Item>()
  for (const prefix of PREFIXES) {
    for (const name of await requested(join(ctx.root, prefix, 'Cellar'))) {
      const item = packageItem('brew', name, 'Homebrew formula')
      items.set(item.id, item)
    }
    for (const entry of await listDir(join(ctx.root, prefix, 'Caskroom'))) {
      if (!entry.isDirectory() || !BREW_NAME.test(entry.name)) continue
      const item = packageItem('cask', entry.name, 'Homebrew app')
      items.set(item.id, item)
    }
  }
  return [...items.values()]
}

// Formulae with at least one version whose install receipt says it was asked for.
async function requested(cellar: string): Promise<string[]> {
  const names: string[] = []
  for (const formula of await listDir(cellar)) {
    if (!formula.isDirectory() || !BREW_NAME.test(formula.name)) continue
    for (const version of await listDir(join(cellar, formula.name))) {
      if (!version.isDirectory()) continue
      if (await onRequest(join(cellar, formula.name, version.name, 'INSTALL_RECEIPT.json'))) {
        names.push(formula.name)
        break
      }
    }
  }
  return names
}

async function onRequest(receipt: string): Promise<boolean> {
  const text = await readHead(receipt, RECEIPT_LIMIT)
  if (text === '') return false
  try {
    return (JSON.parse(text) as { installed_on_request?: unknown }).installed_on_request === true
  } catch {
    return false
  }
}

function packageItem(manager: 'brew' | 'cask', name: string, detail: string): Item {
  return {
    id: `package:${manager}:${name}`,
    kind: 'package',
    category: 'manual',
    name,
    detail,
    origin: `brew:${name}`,
    fingerprint: '',
  }
}
