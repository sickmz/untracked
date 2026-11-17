// The contract every collector, the store and the renderers share.

// Why an item is listed. The order is the order of the report.
//   manual     nobody but the user put it there: no package manager or installer accounts for it
//   orphan     a config or script that names a program which is not installed
//   unclaimed  a directory no installed program accounts for (a weaker signal than orphan)
//   anomaly    a runtime oddity: a directory with too many entries, zombie processes, piled-up versions
//   space      one of the largest directories of the home: where the disk space is
//   installed  put there by a tool's own installer or self-updater, outside any package manager
//   managed    owned by a package manager (dpkg, Homebrew, npm, bun, pip, cargo): reinstalling restores it
export type Category = 'manual' | 'orphan' | 'unclaimed' | 'anomaly' | 'space' | 'installed' | 'managed'

export type Kind =
  | 'binary' // compiled executable
  | 'script' // executable text file
  | 'shell_function'
  | 'shell_alias'
  | 'shell_env' // exported variable or PATH edit: the name only, never the value
  | 'shell_source' // a line that sources another file
  | 'config' // hand-written configuration file
  | 'key' // SSH key, by name only
  | 'hook' // a command some tool's configuration runs
  | 'service' // systemd unit or launchd job
  | 'cron'
  | 'repo' // git checkout
  | 'dir' // plain directory of the user's own files
  | 'state_dir' // directory a program keeps its state in
  | 'package' // globally installed package
  | 'anomaly'
  | 'space' // a large directory

export type Item = {
  // `${kind}:${key}`. The key is a home-relative path ("~/scripts/x") or a name. Stable across scans.
  id: string
  kind: Kind
  category: Category
  // Short label, shown first.
  name: string
  // A few plain words with what the name, the path and the section heading do not already say.
  // '' when there is nothing to add.
  detail: string
  // Location, written with a leading "~/" when inside the home.
  path?: string
  // Who put it there, as `${source}:${name}`: "dpkg:jq", "npm:corepack", "installer:aws-cli".
  origin?: string
  // What counts as a change between two scans. '' means only presence matters.
  // Never the content itself, never a size or a time that moves on its own.
  fingerprint: string
  // Disk space in bytes, when it was measured. Shown, never compared.
  size?: number
}

export type RunResult = {
  code: number
  stdout: string
}

export type Context = {
  // Absolute path of the home being scanned, no trailing slash.
  home: string
  // PATH entries, absolute, in lookup order.
  path_dirs: string[]
  // Where the system starts: "/". Collectors that look outside the home read below it and
  // show paths without it. null means the scan stays inside the home.
  root: string | null
  // Where the distribution keeps the default dotfiles of a new user.
  skel_dir: string
  // Runs a read-only system query (dpkg, systemctl, crontab). Returns code 127 when the command
  // does not exist. Never use it to execute a file found during the scan.
  run(cmd: string, args: string[]): Promise<RunResult>
  // Absolute path of a command found through path_dirs, or null.
  which(command: string): Promise<string | null>
}

export type Collector = (ctx: Context) => Promise<Item[]>

export type Snapshot = {
  version: 1
  taken_at: string
  home: string
  items: Item[]
}

export type Change = {
  type: 'added' | 'removed' | 'changed'
  item: Item
  // The earlier state of a changed item.
  before?: Item
}

// Item id to the user's note about it.
export type Notes = Record<string, string>
