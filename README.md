# untracked

untracked lists what you put on a Linux or macOS machine, and what was left behind: scripts, programs, shell functions, config files, SSH keys, services, cron jobs, packages you asked for, leftovers of removed tools. It also tells you what changed since the last look.

It reads your home and a few system places (apt and snap on Debian and Ubuntu, Homebrew and launchd on macOS).

## Run it

Needs [Bun](https://bun.sh).

```sh
bun install
bun run untracked scan
bun run build
```

## Commands

- `untracked scan` prints the inventory and saves a snapshot. `--all` also shows what installers and package managers put there, `--json` prints JSON, `--no-save` skips the snapshot, `--home DIR` scans another directory.
- `untracked diff` compares your home with the latest snapshot. Updates of installed tools and sizes are not changes.
- `untracked export [--out FILE]` writes the inventory as Markdown.
- `untracked note <path-or-id> <text>` attaches a note to an item. `--remove` deletes it.

## Example

```
$ untracked scan
Put there by hand (9)
  Programs      ~/tools/fetch-logs                  92 MB
                note: needs the token from the team vault
  Scripts       ~/.local/bin/check                         link to ~/notes/check/bin/check
  Functions     deploy-stage                               ~/.zshrc
  Services      local.sync-notes.plist                     starts ~/tools/sync-notes at login
  Config files  ~/.tmux.conf
  SSH keys      ~/.ssh/id_work
  Checkouts     ~/code/shop-api                     2.1 GB  git@git.example.test:team/shop-api.git
  Packages      brew: jq, ripgrep, wget
                npm: acme-cli

Left behind (2)
  Services  com.acme.updater.plist  starts /opt/acme/updater, which is missing
  Hooks     notify.sh               ~/.claude/settings.json  left by acme, which is not installed

Unclaimed directories (2)
  No installed program matches these.
  ~/.acme          3.0 GB
  ~/.config/orbit   20 MB

Where the space is (3)
  ~                 31.4 GB
  ~/Library          8.2 GB
  ~/code/shop-api    2.1 GB

Not shown: 6 installed by their own installer, 12 from a package manager. Use --all to list them.
Snapshot saved.

$ untracked diff
Put there by hand (2)
+ Scripts    ~/tools/sync-photos
- Functions  deploy-stage         ~/.zshrc

1 added, 1 removed since 2026-11-10 08:30 UTC.
```

## Files and limits

Snapshots go to `~/.local/state/untracked`, notes to `~/.config/untracked` (or `$UNTRACKED_STATE_DIR`, `$UNTRACKED_CONFIG_DIR`, XDG paths).

Categories are guesses from paths, names and package databases: check an item before deleting it. System files you edited in `/etc` are not found. On macOS, apps in `/Applications` and files inside `~/Library` are not listed.
