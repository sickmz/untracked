import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { hashText, readHead, tilde } from '../lib/fs'
import type { Context, Item } from '../types'

const STARTUP_FILES = [
  '.bashrc',
  '.bash_profile',
  '.bash_aliases',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.bash_logout',
]
const FILE_LIMIT = 1024 * 1024
const FUNCTION_HEAD =
  /^(?:function\s+([A-Za-z_][\w:.+-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w:.+-]*)\s*\(\s*\))\s*(?:\{[\s\S]*)?$/
export const ASSIGNMENT = /^([A-Za-z_]\w*)=/
const ALIAS_NAME = /^[\w.:+@%-]+$/
const TOOL_NAME = /^[\w.+-]+$/
const SAFE_PATH = /^[\w./~${}@+:,=*?[\]-]+$/
const OPERATORS = new Set([';', ';;', '&', '&&', '|', '||'])
export const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '('])
// Shell builtins: never looked up on PATH, so never reported as missing.
export const BUILTINS = new Set([
  ...KEYWORDS,
  '.', ':', '[', '[[', 'builtin', 'cd', 'command', 'echo', 'eval', 'exit', 'export', 'false', 'fi', 'done', 'hash',
  'local', 'popd', 'printf', 'pushd', 'read', 'return', 'set', 'shift', 'source', 'test', 'trap', 'true', 'type',
  'typeset', 'ulimit', 'umask', 'unset', 'wait',
])

// Characters after which a "#" starts a comment.
const WORD_BREAK = /[\s;&|()]/

// A variable maps to null once it has been given two different values: which one holds is unknown.
type Vars = Map<string, string | null>

// One command line of a shell file, as the shell reads it.
type Line = {
  // Backslash continuations joined; a quoted string that spans several lines stays whole, newlines included.
  text: string
  // The bodies of the heredocs this line opens. Never parsed, only hashed with a function body.
  heredoc: string
}

type Heredoc = {
  word: string
  // "<<-": leading tabs are stripped before the end word is matched.
  strip: boolean
}

type FileState = {
  ctx: Context
  label: string
  vars: Vars
  items: Map<string, Item>
  // Function and alias ids already used by an earlier startup file.
  taken: Set<string>
}

export async function collectShell(ctx: Context): Promise<Item[]> {
  const taken = new Set<string>()
  const result: Item[] = []
  // Sequential on purpose: the first file in STARTUP_FILES keeps the bare function and alias ids.
  for (const name of STARTUP_FILES) {
    const items = await readStartup(ctx, name, taken)
    for (const item of items) taken.add(item.id)
    result.push(...items)
  }
  return result
}

async function readStartup(ctx: Context, name: string, taken: Set<string>): Promise<Item[]> {
  const file = join(ctx.home, name)
  if (!(await isFile(file))) return []
  const text = await readHead(file, FILE_LIMIT)
  const skel_file = join(ctx.skel_dir, name)
  const skel = (await isFile(skel_file)) ? await readHead(skel_file, FILE_LIMIT) : ''
  const defaults = new Set(logicalLines(skel).map((line) => line.text))
  const state: FileState = { ctx, label: tilde(ctx.home, file), vars: new Map(), items: new Map(), taken }
  const lines = logicalLines(text)
  let index = 0
  while (index < lines.length) {
    const line = lines[index]?.text ?? ''
    const head = line.match(FUNCTION_HEAD)
    if (head != null) {
      const end = bodyEnd(lines, index)
      const body = lines.slice(index, end + 1)
      const custom = body.some((part) => part.text !== '' && !defaults.has(part.text))
      if (custom) addFunction(state, head[1] ?? head[2] ?? '', body)
      index = end + 1
      continue
    }
    await readLine(state, splitWords(line), line !== '' && !defaults.has(line))
    index++
  }
  return [...state.items.values()]
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

// Index of the line that closes the function starting at `start`.
function bodyEnd(lines: Line[], start: number): number {
  let depth = 0
  let opened = false
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]?.text ?? ''
    if (line.startsWith('#')) continue
    if (!opened && index > start && line !== '' && !line.startsWith('{')) return start
    const [opens, closes] = countBraces(line)
    if (opens > 0) opened = true
    depth += opens - closes
    if (opened && depth <= 0) return index
  }
  return lines.length - 1
}

// Braces outside quotes and comments.
function countBraces(line: string): [number, number] {
  let opens = 0
  let closes = 0
  let quote = ''
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? ''
    if (quote === "'") {
      if (char === "'") quote = ''
      continue
    }
    if (char === '\\') {
      index++
      continue
    }
    if (quote === "$'") {
      if (char === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ''
      continue
    }
    if (char === "'" || char === '"') quote = openQuote(char, line[index - 1])
    if (char === '#' && (index === 0 || WORD_BREAK.test(line[index - 1] ?? ''))) break
    if (char === '{') opens++
    if (char === '}') closes++
  }
  return [opens, closes]
}

function uniqueId(state: FileState, kind: string, name: string): string {
  const bare = `${kind}:${name}`
  if (!state.taken.has(bare)) return bare
  return `${kind}:${state.label}:${name}`
}

function addFunction(state: FileState, name: string, body: Line[]): void {
  const id = uniqueId(state, 'shell_function', name)
  state.items.set(id, {
    id,
    kind: 'shell_function',
    category: 'manual',
    name,
    detail: '',
    path: state.label,
    fingerprint: hashText(body.map((line) => line.text + line.heredoc).join('\n')),
  })
}

// Tracks assignments on every line, so paths resolve, and reports only the lines that are not noise.
async function readLine(state: FileState, words: string[], report: boolean): Promise<void> {
  for (const segment of splitCommands(words)) {
    let start = 0
    while (start < segment.length && KEYWORDS.has(segment[start] ?? '')) start++
    const command = segment.slice(start)
    const first = command[0]
    if (first == null) continue
    if (first === 'export') {
      setVars(state, command.slice(1), report)
      continue
    }
    if (command.every((word) => ASSIGNMENT.test(word))) {
      setVars(state, command, report)
      continue
    }
    if (!report) continue
    if (first === 'alias') addAliases(state, command.slice(1))
    if (first === 'source' || first === '.') await addSource(state, command[1])
    if (first === 'eval') await addStartup(state, command.slice(1).join(' '))
  }
}

function setVars(state: FileState, words: string[], report: boolean): void {
  for (const word of words) {
    const match = word.match(ASSIGNMENT)
    if (match == null) continue
    const name = match[1] ?? ''
    const value = substitute(word.slice(name.length + 1), state.ctx.home, state.vars)
    const known = !state.vars.has(name) || state.vars.get(name) === value
    state.vars.set(name, known ? value : null)
    if (!report) continue
    const id = `shell_env:${state.label}:${name}`
    state.items.set(id, {
      id,
      kind: 'shell_env',
      category: 'manual',
      name,
      detail: '',
      path: state.label,
      fingerprint: '',
    })
  }
}

function addAliases(state: FileState, words: string[]): void {
  for (const word of words) {
    const split = word.indexOf('=')
    if (split <= 0) continue
    const name = word.slice(0, split)
    if (!ALIAS_NAME.test(name)) continue
    const id = uniqueId(state, 'shell_alias', name)
    state.items.set(id, {
      id,
      kind: 'shell_alias',
      category: 'manual',
      name,
      detail: '',
      path: state.label,
      fingerprint: hashText(word),
    })
  }
}

async function addSource(state: FileState, target: string | undefined): Promise<void> {
  if (target == null) return
  if (target.startsWith('<(')) return addStartup(state, target)
  const name = safeName(target)
  if (name == null) return
  const id = `shell_source:${state.label}:file:${name}`
  const item: Item = {
    id,
    kind: 'shell_source',
    category: 'manual',
    name,
    detail: '',
    path: state.label,
    fingerprint: '',
  }
  const resolved = expandPath(target, state.ctx.home, state.vars)
  if (resolved != null && !(await present(resolved))) {
    item.category = 'orphan'
    item.detail = 'the file is missing'
  }
  state.items.set(id, item)
}

// The sourced path as written, with any command substitution cut down to "$(…)" so its arguments never leave.
function safeName(target: string): string | null {
  const substituted = target.includes('$(') || target.includes('`')
  const cut = Math.max(target.lastIndexOf(')'), target.lastIndexOf('`'))
  const name = substituted ? `$(…)${target.slice(cut + 1)}` : target
  if (!SAFE_PATH.test(name.replace('$(…)', ''))) return null
  return name
}

export async function present(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

// `text` holds a command substitution such as `"$(tool init bash)"`. Reports the tool it runs, never its arguments.
async function addStartup(state: FileState, text: string): Promise<void> {
  const inner = innerCommand(text)
  if (inner == null) return
  const program = splitWords(inner).find((word) => !ASSIGNMENT.test(word))
  if (program == null || BUILTINS.has(program)) return
  const name = basename(program)
  if (!TOOL_NAME.test(name)) return
  const id = `shell_source:${state.label}:run:${name}`
  const item: Item = {
    id,
    kind: 'shell_source',
    category: 'manual',
    name,
    detail: 'runs at startup',
    path: state.label,
    fingerprint: '',
  }
  const lookup = program.includes('/') ? expandPath(program, state.ctx.home, state.vars) : program
  if (lookup != null && (await state.ctx.which(lookup)) == null) {
    item.category = 'orphan'
    item.detail = 'runs at startup, but is not installed'
  }
  state.items.set(id, item)
}

function innerCommand(text: string): string | null {
  const open = text.search(/[$<]\(/)
  if (open >= 0) {
    const close = text.lastIndexOf(')')
    if (close <= open) return null
    return text.slice(open + 2, close)
  }
  const tick = text.indexOf('`')
  const end = text.lastIndexOf('`')
  if (tick >= 0 && end > tick) return text.slice(tick + 1, end)
  return null
}

// Replaces "~", $HOME and known variables. Null when something is left that only the running shell knows.
export function substitute(text: string, home: string, vars: Vars): string | null {
  let unknown = false
  const tilded = text === '~' || text.startsWith('~/') ? home + text.slice(1) : text
  const value = tilded.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced?: string, plain?: string) => {
    const name = braced ?? plain ?? ''
    if (name === 'HOME') return home
    const known = vars.get(name)
    if (known == null) unknown = true
    return known ?? ''
  })
  if (unknown || /[$`*?[]/.test(value)) return null
  return value
}

// The absolute path the text names, or null when it cannot be resolved without running the shell.
export function expandPath(text: string, home: string, vars: Vars): string | null {
  const value = substitute(text, home, vars)
  if (value == null || !isAbsolute(value)) return null
  return value
}

// "$'…'" quotes accept backslash escapes, plain single quotes do not.
function openQuote(char: string, before: string | undefined): string {
  return char === "'" && before === '$' ? "$'" : char
}

// Splits a file into the lines the shell runs. Heredoc bodies and the inner lines of a quoted string that
// spans several lines are never lines of their own, so their content is never parsed as a command.
function logicalLines(text: string): Line[] {
  const lines: Line[] = []
  let line = ''
  let quote = ''
  let comment = false
  // Depth of "((": inside arithmetic, "<<" is a shift, not a heredoc.
  let arith = 0
  let heredocs: Heredoc[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    const next = text[index + 1] ?? ''
    if (char === '\n' && quote === '') {
      const bodies = readBodies(text, index + 1, heredocs)
      lines.push({ text: line.trim(), heredoc: bodies.text })
      line = ''
      comment = false
      arith = 0
      heredocs = []
      index = bodies.end
      continue
    }
    if (comment) {
      line += char
      index++
      continue
    }
    if (quote === "$'") {
      if (char === "'") quote = ''
      line += char === '\\' ? char + next : char
      index += char === '\\' ? 2 : 1
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = ''
      line += char
      index++
      continue
    }
    if (char === '\\') {
      if (next !== '\n') line += char + next
      index += 2
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ''
      line += char
      index++
      continue
    }
    if (char === "'" || char === '"') quote = openQuote(char, line[line.length - 1])
    if (char === '#' && (line === '' || WORD_BREAK.test(line[line.length - 1] ?? ''))) comment = true
    if (char === '(' && next === '(') arith++
    if (char === ')' && next === ')') arith = Math.max(0, arith - 1)
    if (char === '<' && next === '<' && arith === 0) {
      const operator = text[index + 2] === '<' ? null : readDelimiter(text, index + 2)
      const end = operator?.end ?? index + (text[index + 2] === '<' ? 3 : 2)
      if (operator != null) heredocs = [...heredocs, operator.heredoc]
      line += text.slice(index, end)
      index = end
      continue
    }
    line += char
    index++
  }
  lines.push({ text: line.trim(), heredoc: '' })
  return lines
}

// The end word of a heredoc whose "<<" ends just before `start`. Quotes around the word are removed.
function readDelimiter(text: string, start: number): { heredoc: Heredoc; end: number } | null {
  let index = start
  const strip = text[index] === '-'
  if (strip) index++
  while (text[index] === ' ' || text[index] === '\t') index++
  let word = ''
  let quote = ''
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '\n') break
    if (quote !== '') {
      if (char === quote) quote = ''
      else word += char
      index++
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      index++
      continue
    }
    if (char === '\\') {
      word += text[index + 1] ?? ''
      index += 2
      continue
    }
    if (/[\s;&|<>()]/.test(char)) break
    word += char
    index++
  }
  if (word === '') return null
  return { heredoc: { word, strip }, end: index }
}

// Skips the bodies of `heredocs`, in order, starting at `start`. Returns them and where the next line starts.
function readBodies(text: string, start: number, heredocs: Heredoc[]): { text: string; end: number } {
  let index = start
  let body = ''
  for (const heredoc of heredocs) {
    while (index < text.length) {
      const newline = text.indexOf('\n', index)
      const end = newline < 0 ? text.length : newline
      const line = text.slice(index, end)
      index = end + 1
      const check = heredoc.strip ? line.replace(/^\t+/, '') : line
      if (check === heredoc.word) break
      body += `${line}\n`
    }
  }
  return { text: body, end: Math.min(index, text.length) }
}

// Splits one line of shell into words, with quotes removed and operators (";", "&&", "|") as their own words.
// Command substitutions "$(…)", "<(…)" and backticks stay whole inside the word that holds them.
export function splitWords(line: string): string[] {
  const words: string[] = []
  let word = ''
  let started = false
  let quote = ''
  let depth = 0
  let backtick = false
  function flush(): void {
    if (started) words.push(word)
    word = ''
    started = false
  }
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? ''
    const next = line[index + 1] ?? ''
    if (depth > 0) {
      word += char
      if (char === '(') depth++
      if (char === ')') depth--
      continue
    }
    if (backtick) {
      word += char
      if (char === '`') backtick = false
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = ''
      else word += char
      continue
    }
    if (char === '\\') {
      word += next
      started = true
      index++
      continue
    }
    if ((char === '$' || char === '<') && next === '(') {
      word += char + next
      started = true
      depth = 1
      index++
      continue
    }
    if (char === '`') {
      word += char
      started = true
      backtick = true
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ''
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      flush()
      continue
    }
    if (char === '#' && !started) break
    if (char === ';' || char === '&' || char === '|') {
      flush()
      const operator = next === char ? char + next : char
      words.push(operator)
      index += operator.length - 1
      continue
    }
    word += char
    started = true
  }
  flush()
  return words
}

// Groups words into simple commands, split at operators.
export function splitCommands(words: string[]): string[][] {
  const commands: string[][] = [[]]
  for (const word of words) {
    if (OPERATORS.has(word)) commands.push([])
    else commands[commands.length - 1]?.push(word)
  }
  return commands.filter((command) => command.length > 0)
}
