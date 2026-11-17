import { expect, test } from 'bun:test'
import { isIgnored } from '../src/ignore'

test('history and state files are ignored', () => {
  for (const name of [
    '.bash_history',
    '.zsh_history',
    '.python_history',
    '.lesshst',
    '.wget-hsts',
    '.viminfo',
    '.sudo_as_admin_successful',
    '.motd_shown',
    '.Xauthority',
    '.zcompdump',
    '.zcompdump-host-5.9',
    'session.lock',
    '.db.lck',
  ]) {
    expect(isIgnored(name)).toBe(true)
  }
})

test("standard directories and untracked's own directories are ignored", () => {
  for (const name of ['.cache', '.ssh', '.gnupg', '.pki', '.local', '.config', '.config/untracked', '.local/state/untracked']) {
    expect(isIgnored(name)).toBe(true)
  }
})

test('hand-written files and application directories are not ignored', () => {
  for (const name of ['.gitconfig', '.tmux.conf', '.acme', '.config/acme', '.local/share/acme', 'projects']) {
    expect(isIgnored(name)).toBe(false)
  }
})

test("untracked's directory name is matched by path, not by name", () => {
  expect(isIgnored('.local/share/untracked')).toBe(false)
})
