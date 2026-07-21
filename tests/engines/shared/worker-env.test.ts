import { describe, expect, test } from 'vitest'
import { buildWorkerEnv } from '../../../src/engines/shared/worker-env'

describe('buildWorkerEnv', () => {
  test('keeps allow-listed session vars and drops secrets + parent-session vars', () => {
    // Arrange
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/Users/dev',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      CODEX_HOME: '/Users/dev/.codex',
      // must never reach a worker:
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_BASE_URL: 'https://proxy.internal',
      CLAUDE_CODE_SESSION: '1',
      OPENAI_API_KEY: 'sk-oai-xxx',
      GH_TOKEN: 'ghp_xxx',
      AWS_SECRET_ACCESS_KEY: 'xxx',
      NPM_TOKEN: 'npm_xxx',
      SOME_RANDOM_SECRET: 'nope',
    }

    // Act
    const env = buildWorkerEnv(source)

    // Assert
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/dev',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      CODEX_HOME: '/Users/dev/.codex',
    })
  })

  test('drops undefined values and never injects extra keys', () => {
    // Arrange
    const source: NodeJS.ProcessEnv = { PATH: '/bin', TMPDIR: undefined }

    // Act
    const env = buildWorkerEnv(source)

    // Assert
    expect(env).toEqual({ PATH: '/bin' })
    expect(env).not.toHaveProperty('ECC_GATEGUARD')
  })
})
