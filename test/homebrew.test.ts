import { afterEach, expect, test } from 'bun:test'
import { collectHomebrew } from '../src/collectors/homebrew'
import { type Fixture, makeHome } from './fixture'

let fixture: Fixture | null = null

afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
})

function receipt(on_request: boolean): string {
  return JSON.stringify({ installed_on_request: on_request, installed_as_dependency: !on_request })
}

test('formulae asked for and casks are listed, dependencies are not', async () => {
  fixture = await makeHome(
    {},
    {
      sys: {
        '/sys/opt/homebrew/Cellar/ripgrep/14.1.0/INSTALL_RECEIPT.json': receipt(true),
        '/sys/opt/homebrew/Cellar/pcre2/10.42/INSTALL_RECEIPT.json': receipt(false),
        '/sys/opt/homebrew/Cellar/acme-cli/2.0.0/INSTALL_RECEIPT.json': receipt(false),
        '/sys/opt/homebrew/Cellar/acme-cli/2.1.0/INSTALL_RECEIPT.json': receipt(true),
        '/sys/opt/homebrew/Cellar/no-receipt/1.0/bin/x': '',
        '/sys/opt/homebrew/Caskroom/orbit-editor/3.2.0/.metadata': { dir: true },
      },
    },
  )
  const items = await collectHomebrew(fixture.ctx)
  expect(items.map((item) => item.id).sort()).toEqual([
    'package:brew:acme-cli',
    'package:brew:ripgrep',
    'package:cask:orbit-editor',
  ])
  const ripgrep = items.find((item) => item.name === 'ripgrep')
  expect(ripgrep).toEqual({
    id: 'package:brew:ripgrep',
    kind: 'package',
    category: 'manual',
    name: 'ripgrep',
    detail: 'Homebrew formula',
    origin: 'brew:ripgrep',
    fingerprint: '',
  })
  expect(JSON.stringify(items)).not.toContain('14.1.0')
})

test('both Homebrew prefixes are read, and a formula in both is listed once', async () => {
  fixture = await makeHome(
    {},
    {
      sys: {
        '/sys/opt/homebrew/Cellar/jq/1.7.1/INSTALL_RECEIPT.json': receipt(true),
        '/sys/usr/local/Cellar/jq/1.6/INSTALL_RECEIPT.json': receipt(true),
        '/sys/usr/local/Cellar/wget/1.24/INSTALL_RECEIPT.json': receipt(true),
      },
    },
  )
  const items = await collectHomebrew(fixture.ctx)
  expect(items.map((item) => item.id).sort()).toEqual(['package:brew:jq', 'package:brew:wget'])
})

test('a damaged receipt and a strange name are skipped', async () => {
  fixture = await makeHome(
    {},
    {
      sys: {
        '/sys/opt/homebrew/Cellar/broken/1.0/INSTALL_RECEIPT.json': '{ not json',
        '/sys/opt/homebrew/Cellar/x; rm -rf ~/1.0/INSTALL_RECEIPT.json': receipt(true),
      },
    },
  )
  expect(await collectHomebrew(fixture.ctx)).toEqual([])
})

test('nothing is read outside the home when the scan stays inside it', async () => {
  fixture = await makeHome({}, { sys: { '/sys/opt/homebrew/Cellar/jq/1.7.1/INSTALL_RECEIPT.json': receipt(true) } })
  expect(await collectHomebrew({ ...fixture.ctx, root: null })).toEqual([])
})
