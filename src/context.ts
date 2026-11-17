import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context, RunResult } from './types'

const RUN_TIMEOUT = 20000

export function createContext(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Context {
  const root = resolve(home)
  const path_dirs = splitPath(env.PATH ?? '')
  // System queries are looked up outside the home only, so a file the scan lists can never be the one it runs.
  const system_dirs = path_dirs.filter((dir) => dir !== root && !dir.startsWith(`${root}/`))
  return {
    home: root,
    path_dirs,
    root: '/',
    skel_dir: '/etc/skel',
    run: (cmd, args) => run(system_dirs, cmd, args),
    which: (command) => findCommand(path_dirs, command),
  }
}

export function splitPath(value: string): string[] {
  const dirs = value.split(':').filter((dir) => isAbsolute(dir))
  return [...new Set(dirs)]
}

export async function findCommand(path_dirs: string[], command: string): Promise<string | null> {
  if (command.includes('/')) return (await isRunnable(command)) ? command : null
  for (const dir of path_dirs) {
    const file = join(dir, command)
    if (await isRunnable(file)) return file
  }
  return null
}

async function isRunnable(file: string): Promise<boolean> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function run(system_dirs: string[], cmd: string, args: string[]): Promise<RunResult> {
  // The program is started by its absolute path, so nothing else on PATH can stand in for it.
  const program = await findCommand(system_dirs, cmd)
  if (program == null) return { code: 127, stdout: '' }
  const proc = Bun.spawn([program, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: RUN_TIMEOUT,
  })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  // A query cut short would silently change what the scan reports, so it stops the scan instead.
  if (proc.signalCode != null) throw new Error(`${cmd} did not answer within ${RUN_TIMEOUT / 1000} seconds`)
  return { code, stdout }
}
