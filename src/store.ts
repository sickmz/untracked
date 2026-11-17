import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compare } from './diff'
import type { Notes, Snapshot } from './types'

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UNTRACKED_STATE_DIR) return env.UNTRACKED_STATE_DIR
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'untracked')
  return join(homedir(), '.local', 'state', 'untracked')
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UNTRACKED_CONFIG_DIR) return env.UNTRACKED_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'untracked')
  return join(homedir(), '.config', 'untracked')
}

// Writes the snapshot unless its items match the latest snapshot of the same home.
// Returns true when a file was written.
export async function saveSnapshot(dir: string, snapshot: Snapshot): Promise<boolean> {
  const latest = await latestSnapshot(dir, snapshot.home)
  if (latest != null && compare(latest.items, snapshot.items).length === 0) return false
  const snapshots_dir = join(dir, 'snapshots')
  await mkdir(snapshots_dir, { recursive: true, mode: 0o700 })
  const taken = await listSnapshots(snapshots_dir)
  let name = `${snapshot.taken_at.replaceAll(':', '-')}.json`
  for (let n = 1; taken.includes(name); n++) name = `${snapshot.taken_at.replaceAll(':', '-')}_${n}.json`
  await writeSecret(join(snapshots_dir, name), `${JSON.stringify(snapshot, null, 2)}\n`)
  return true
}

// The most recent snapshot of this home, or null.
export async function latestSnapshot(dir: string, home: string): Promise<Snapshot | null> {
  const snapshots_dir = join(dir, 'snapshots')
  let latest: Snapshot | null = null
  for (const name of await listSnapshots(snapshots_dir)) {
    const snapshot = parseSnapshot(await readFile(join(snapshots_dir, name), 'utf8'))
    if (snapshot == null || snapshot.home !== home) continue
    if (latest == null || snapshot.taken_at >= latest.taken_at) latest = snapshot
  }
  return latest
}

// A snapshot file cut short by a crash or a full disk is skipped: an older one still serves.
function parseSnapshot(text: string): Snapshot | null {
  try {
    const snapshot = JSON.parse(text) as Snapshot
    return Array.isArray(snapshot?.items) ? snapshot : null
  } catch {
    return null
  }
}

export async function loadNotes(dir: string): Promise<Notes> {
  const file = join(dir, 'notes.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as Notes
  } catch {
    // Notes are the user's own words: say where the broken file is instead of dropping them.
    throw new Error(`${file} is not valid JSON. Fix it or delete it.`)
  }
}

export async function saveNotes(dir: string, notes: Notes): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeSecret(join(dir, 'notes.json'), `${JSON.stringify(notes, null, 2)}\n`)
}

// File names sorted oldest first. A same-millisecond suffix ("_1") sorts after the plain name.
async function listSnapshots(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

// Writes through a temporary file so a crash never leaves half a file, readable by the owner only.
async function writeSecret(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, file)
}
