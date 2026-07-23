// Workers run as a FRESH first-party CLI session on the user's OWN seat, so the child env
// is rebuilt from a strict allow-list rather than inheriting the MCP server's process env.
// Two reasons: (1) parent Claude Code session vars (ANTHROPIC_BASE_URL proxy, CLAUDE_CODE_*
// markers) would 401 the child against a session-scoped proxy instead of its own Keychain
// OAuth; (2) an autonomous worker with shell/write access must never see unrelated shell
// secrets (OPENAI_API_KEY, GH_TOKEN, AWS_*, NPM_TOKEN, …) that it could echo into its diff.
// Auth itself lives on disk (~/.codex/auth.json, ~/.claude via HOME), not in env vars.
// The allow-list is the extension point: add a key here if a setup genuinely needs it
// (e.g. NODE_EXTRA_CA_CERTS behind a corporate TLS proxy) — never fall back to inheriting.
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
  'TMPDIR',
  'TZ',
  'LANG',
  'CODEX_HOME', // codex reads its subscription auth from here (defaults to ~/.codex)
  '__CF_USER_TEXT_ENCODING', // macOS CoreFoundation locale
])

// Locale family (LC_ALL, LC_CTYPE, …) — allow the whole prefix.
const ALLOWED_PREFIXES: readonly string[] = ['LC_']

// Windows OS plumbing (SystemRoot, ComSpec, PATHEXT, …) plus the Windows homes of
// on-disk CLI auth (USERPROFILE, APPDATA, LOCALAPPDATA). Names are stored uppercase
// and matched case-insensitively on win32 only — Windows env names are case-insensitive
// and real environments mix casings (`Path`, `SystemRoot`, `windir`).
const WINDOWS_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
])

function matchesAllowList(key: string): boolean {
  return ALLOWED_KEYS.has(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

function isAllowed(key: string, platform: NodeJS.Platform): boolean {
  if (matchesAllowList(key)) return true
  if (platform !== 'win32') return false
  const upper = key.toUpperCase()
  return matchesAllowList(upper) || WINDOWS_ALLOWED_KEYS.has(upper)
}

// Fully REPLACES (never merges) the child env — pass the result as spawn/execFile `env`.
export function buildWorkerEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && isAllowed(entry[0], platform),
  )
  return Object.fromEntries(entries)
}
