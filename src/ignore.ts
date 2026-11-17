// What untracked never reports: files programs write on their own, standard directories that belong
// to no application, and the tool's own state. Names match the last path segment; paths are
// home-relative and match exactly.

export const IGNORED_NAMES = [
  // history and state written by programs
  '.lesshst',
  '.wget-hsts',
  '.viminfo',
  '.sudo_as_admin_successful',
  '.motd_shown',
  '.selected_editor',
  '.histfile',
  '.z',
  '.Xauthority',
  '.ICEauthority',
  '.xsession-errors',
  '.DS_Store',
  '.CFUserTextEncoding',
  // standard directories
  '.cache',
  '.ssh',
  '.gnupg',
  '.pki',
  '.local',
  '.config',
  '.Trash',
]

export const IGNORED_PATTERNS = [/_history$/, /^\.zcompdump/, /\.lock$/, /\.lck$/]

export const IGNORED_PATHS = [
  // the tool's own state and config
  '.config/untracked',
  '.local/state/untracked',
  // made by the system, not by an application
  'Library',
  'snap',
  '.config/autostart',
  '.config/systemd',
  '.local/share/Trash',
  '.local/share/applications',
  '.local/share/fonts',
  '.local/share/icons',
  '.local/share/mime',
  '.local/share/pki',
  '.local/share/keyrings',
]

// `name` is a file name or a home-relative path such as ".config/untracked".
export function isIgnored(name: string): boolean {
  if (IGNORED_PATHS.includes(name)) return true
  const base = name.slice(name.lastIndexOf('/') + 1)
  if (IGNORED_NAMES.includes(base)) return true
  return IGNORED_PATTERNS.some((pattern) => pattern.test(base))
}
