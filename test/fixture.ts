import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findCommand } from '../src/context'
import type { Context, RunResult } from '../src/types'

// One entry of a synthetic tree.
//   'text'                     a file with this content
//   { text, exec: true }       an executable file
//   { link: '~/target' }       a symlink (see `place` for how targets are written)
//   { dir: true }              an empty directory
export type Entry = string | { text?: string; exec?: boolean; link?: string; dir?: true }

export type Tree = Record<string, Entry>

export type FixtureOptions = {
  // Files outside the home, keyed by a path starting with "/sys/": "/sys/bin/jq".
  // The fixture's "/sys" is also the system root collectors see: "/sys/opt/acme" is "/opt/acme" to them.
  sys?: Tree
  // The default dotfiles of a new user, keyed by file name: ".bashrc".
  skel?: Tree
  // PATH entries: "~/.local/bin" or "/sys/bin".
  path?: string[]
  // Answers of system queries, keyed by the full command line: "dpkg -S /sys/bin/jq".
  // A command line that is not listed answers with code 127.
  run?: Record<string, RunResult>
}

export type Fixture = {
  ctx: Context
  // Absolute path of the synthetic home.
  home: string
  // Absolute path standing in for "/sys".
  sys: string
  // Turns "~/x" or "/sys/x" into the absolute path inside the fixture.
  place(path: string): string
  cleanup(): Promise<void>
}

// Builds a synthetic home in a temporary directory. Keys of `tree` are relative to the home.
// Tests never read the real home: every path a collector sees must come from here.
export async function makeHome(tree: Tree, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'untracked-'))
  const home = join(root, 'home')
  const sys = join(root, 'sys')
  const skel = join(root, 'skel')
  await Promise.all([home, sys, skel].map((dir) => mkdir(dir, { recursive: true })))

  function place(path: string): string {
    if (path === '~') return home
    if (path.startsWith('~/')) return join(home, path.slice(2))
    if (path.startsWith('/sys/')) return join(sys, path.slice(5))
    return path
  }

  await write(home, tree, place)
  await write(skel, options.skel ?? {}, place)
  const sys_tree: Tree = {}
  for (const [key, entry] of Object.entries(options.sys ?? {})) sys_tree[key.replace(/^\/sys\//, '')] = entry
  await write(sys, sys_tree, place)

  const path_dirs = (options.path ?? []).map(place)
  const answers = options.run ?? {}
  const ctx: Context = {
    home,
    path_dirs,
    root: sys,
    skel_dir: skel,
    // An argument inside the fixture is looked up under its "~/..." or "/sys/..." name.
    run: async (cmd, args) => {
      const named = args.map((arg) => {
        if (arg === home) return '~'
        if (arg.startsWith(`${home}/`)) return `~/${arg.slice(home.length + 1)}`
        return arg.startsWith(`${sys}/`) ? `/sys/${arg.slice(sys.length + 1)}` : arg
      })
      return answers[[cmd, ...named].join(' ')] ?? answers[[cmd, ...args].join(' ')] ?? { code: 127, stdout: '' }
    },
    which: (command) => findCommand(path_dirs, command),
  }
  return { ctx, home, sys, place, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function write(base: string, tree: Tree, place: (path: string) => string): Promise<void> {
  for (const [key, entry] of Object.entries(tree)) {
    const file = join(base, key)
    await mkdir(dirname(file), { recursive: true })
    if (typeof entry === 'string') {
      await writeFile(file, entry)
      continue
    }
    if (entry.dir) {
      await mkdir(file, { recursive: true })
      continue
    }
    if (entry.link != null) {
      await symlink(place(entry.link), file)
      continue
    }
    await writeFile(file, entry.text ?? '')
    if (entry.exec) await chmod(file, 0o755)
  }
}
