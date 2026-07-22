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

  test('on win32 keeps OS plumbing vars, matching names case-insensitively', () => {
    // Arrange — real Windows envs mix casings: Path, SystemRoot, windir, ComSpec…
    const source: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\dev',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
      // must never reach a worker, whatever the platform:
      OPENAI_API_KEY: 'sk-oai-xxx',
      ANTHROPIC_BASE_URL: 'https://proxy.internal',
    }

    // Act
    const env = buildWorkerEnv(source, 'win32')

    // Assert
    expect(env).toEqual({
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\dev',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
    })
  })

  test('on POSIX the Windows-only names and case variants stay excluded', () => {
    // Arrange
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      path: '/sneaky/override',
      USERPROFILE: '/should/not/pass',
      TEMP: '/should/not/pass',
    }

    // Act
    const env = buildWorkerEnv(source, 'linux')

    // Assert
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
