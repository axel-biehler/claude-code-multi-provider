import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  listAllProviderModels,
  listProviderModels,
  parseAgyModelsOutput,
  parseCodexConfigModel,
} from '../../src/config/models'

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
}

describe('provider model discovery', () => {
  let temporaryRoot: string
  let pathDirectory: string
  let originalHome: string | undefined
  let originalPath: string | undefined

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'delegate-models-'))
    pathDirectory = join(temporaryRoot, 'path-bin')
    await mkdir(pathDirectory)
    originalHome = process.env.HOME
    originalPath = process.env.PATH
    process.env.HOME = temporaryRoot
    process.env.PATH = [pathDirectory, '/usr/bin', '/bin'].join(delimiter)
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  test('parses agy output in its newest-first order and recommends the first model', () => {
    const models = parseAgyModelsOutput(
      'gemini-3.6-flash-high\ngemini-3.6-flash-medium\nclaude-sonnet-4-6\n',
    )

    expect(models).toEqual([
      { id: 'gemini-3.6-flash-high', recommended: true },
      { id: 'gemini-3.6-flash-medium' },
      { id: 'claude-sonnet-4-6' },
    ])
  })

  test('skips blank and whitespace-only agy output lines', () => {
    const models = parseAgyModelsOutput(
      '\n  gemini-3.6-flash-high  \n\t\n gemini-3.6-flash-low \n',
    )

    expect(models).toEqual([
      { id: 'gemini-3.6-flash-high', recommended: true },
      { id: 'gemini-3.6-flash-low' },
    ])
  })

  test('falls back to the curated agy catalog when the CLI cannot spawn', async () => {
    process.env.PATH = pathDirectory

    const provider = await listProviderModels('antigravity', temporaryRoot)

    expect(provider).toEqual({
      models: [
        { id: 'gemini-3.6-flash-high', recommended: true },
        { id: 'gemini-3.6-flash-medium' },
        { id: 'gemini-3.6-flash-low' },
        { id: 'claude-sonnet-4-6' },
      ],
      source: 'catalog',
    })
  })

  test('lists agy models from the CLI when the probe succeeds', async () => {
    await writeExecutable(
      join(pathDirectory, 'agy'),
      '[ "$1" = "models" ] && printf "gemini-newest\\ngemini-older\\n"',
    )

    const provider = await listProviderModels('antigravity', temporaryRoot)

    expect(provider).toEqual({
      models: [
        { id: 'gemini-newest', recommended: true },
        { id: 'gemini-older' },
      ],
      source: 'cli',
    })
  })

  test('extracts only a top-level codex model assignment', () => {
    const model = parseCodexConfigModel(`
model = "gpt-5.6-sol"

[tui.model_availability_nux]
model = "must-not-match"
`)

    expect(model).toBe('gpt-5.6-sol')
  })

  test('ignores codex model assignments after the first section header', () => {
    const model = parseCodexConfigModel(`
[profiles.work]
model = "must-not-match"
`)

    expect(model).toBeUndefined()
  })

  test('returns an empty codex catalog when its config file is missing', async () => {
    const provider = await listProviderModels('codex', temporaryRoot)

    expect(provider).toEqual({ models: [], source: 'catalog' })
  })

  test('uses the locally configured top-level codex model as the recommendation', async () => {
    const configDirectory = join(temporaryRoot, '.codex')
    await mkdir(configDirectory)
    await writeFile(
      join(configDirectory, 'config.toml'),
      'model = "gpt-5.6-sol"\n[profile.work]\nmodel = "must-not-match"\n',
      'utf8',
    )

    const provider = await listProviderModels('codex', temporaryRoot)

    expect(provider).toEqual({
      models: [{ id: 'gpt-5.6-sol', recommended: true }],
      source: 'catalog',
      defaultModel: 'gpt-5.6-sol',
    })
  })

  test('returns the stable Claude aliases with sonnet recommended', async () => {
    const provider = await listProviderModels('claude', temporaryRoot)

    expect(provider).toEqual({
      models: [
        { id: 'fable' },
        { id: 'opus' },
        { id: 'sonnet', recommended: true },
        { id: 'haiku' },
      ],
      source: 'catalog',
      defaultModel: 'sonnet',
    })
  })

  test('lists every provider even when live model discovery fails', async () => {
    process.env.PATH = pathDirectory

    const providers = await listAllProviderModels(temporaryRoot)

    expect(Object.keys(providers).sort()).toEqual(['antigravity', 'claude', 'codex'])
    expect(providers.antigravity.source).toBe('catalog')
    expect(providers.codex.models).toEqual([])
    expect(providers.claude.defaultModel).toBe('sonnet')
  })
})
