// OpenCode (opencode.ai, version 2), one of the coding agents harness.ts drives over ACP. Installed for everyone by
// deploy/opencode-update.sh. Everything DevDash needs it to do differently is set per session through
// OPENCODE_CONFIG_CONTENT, which outranks the member's own and the project's config (checked against 2.2.5), so nothing
// is written into anyone's files.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const OPENCODE_HOME = process.env.DEVDASH_OPENCODE_HOME ?? '/opt/devdash/opencode/current'
export const OPENCODE_BIN = join(OPENCODE_HOME, 'bin', 'opencode')
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,20}$/
/** DevDash's plugin for OpenCode's terminal app: it reports the CLI's status, as Claude Code's hooks do. */
export const PLUGIN_DIR = fileURLToPath(new URL('../../../packages/opencode-plugin', import.meta.url))

/**
 * A profile is its own OpenCode database: its provider logins and its sessions. Settings, agents and skills
 * (~/.config/opencode) are shared by the member's profiles.
 */
export const profileDir = (p: string) => join(homedir(), '.opencode-profiles', p)
export const profileEnv = (p: string): Record<string, string> => (p === 'default' ? {} : { OPENCODE_DB: join(profileDir(p), 'opencode.db') })

export function profileNames() {
  const root = join(homedir(), '.opencode-profiles')
  return ['default', ...(existsSync(root) ? readdirSync(root).filter((n) => PROFILE_RE.test(n) && n !== 'default') : [])]
}
export function createProfile(name: string) {
  if (!PROFILE_RE.test(name) || name === 'default') throw new Error('Profile names use lowercase letters, digits and dashes.')
  mkdirSync(profileDir(name), { recursive: true, mode: 0o700 })
}

/** Commands for OpenCode's own server, never the shared background one it starts by default (one per user, its own port). */
const STANDALONE = '--standalone'
const opencode = (profile: string, args: string[], timeout = 30_000) =>
  run(OPENCODE_BIN, [...args, STANDALONE], { env: { ...process.env, ...profileEnv(profile) }, timeout, cwd: homedir() }).then((r) => r.stdout)

export const installed = () => existsSync(OPENCODE_BIN)

let versionCache: { key: string; value: Promise<string | null> } | undefined
function binSignature(): string {
  try {
    const real = realpathSync(OPENCODE_BIN)
    const st = statSync(real)
    return `${real}:${st.size}:${Math.trunc(st.mtimeMs)}`
  } catch {
    return OPENCODE_BIN
  }
}

export async function version() {
  if (!installed()) return null
  try {
    const real = realpathSync(OPENCODE_BIN)
    const pkgPath = join(dirname(real), '..', 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) {
        return pkg.version.match(/\d+\.\d+\.\d+/)?.[0] ?? null
      }
    }
  } catch { /* fall back to --version */ }
  const key = binSignature()
  if (versionCache?.key === key) return versionCache.value
  const value = run(OPENCODE_BIN, ['--version'], { timeout: 10_000 })
    .then((r) => r.stdout, () => '')
    .then((out) => out.match(/\d+\.\d+\.\d+/)?.[0] ?? null)
  versionCache = { key, value }
  return value
}

const PROVIDER_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  gemini: 'Google',
  'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  mistral: 'Mistral',
  'amazon-bedrock': 'Amazon Bedrock',
  azure: 'Azure',
}
const ENV_PROVIDERS: [string, string][] = [
  ['ANTHROPIC_API_KEY', 'Anthropic'],
  ['OPENAI_API_KEY', 'OpenAI'],
  ['GEMINI_API_KEY', 'Google'],
  ['GOOGLE_GENERATIVE_AI_API_KEY', 'Google'],
  ['OPENROUTER_API_KEY', 'OpenRouter'],
  ['XAI_API_KEY', 'xAI'],
  ['GROQ_API_KEY', 'Groq'],
  ['DEEPSEEK_API_KEY', 'DeepSeek'],
  ['MISTRAL_API_KEY', 'Mistral'],
]

function defaultDataDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')
}
function profileDbPath(profile: string) {
  return profile === 'default' ? join(defaultDataDir(), 'opencode.db') : join(profileDir(profile), 'opencode.db')
}
function profileAuthJsonPath(profile: string) {
  return profile === 'default' ? join(defaultDataDir(), 'auth.json') : join(profileDir(profile), 'auth.json')
}
function fileSig(file: string): string {
  try {
    const st = statSync(file)
    return `${st.size}:${Math.trunc(st.mtimeMs)}`
  } catch {
    return '-'
  }
}
function profileAuthSignature(profile: string): string {
  const db = profileDbPath(profile)
  const envKeys = ENV_PROVIDERS.filter(([k]) => !!process.env[k]).map(([k]) => k).join(',')
  return `${fileSig(db)}|${fileSig(db + '-wal')}|${fileSig(profileAuthJsonPath(profile))}|${envKeys}`
}
const providerLabel = (id: string) => PROVIDER_LABELS[id] ?? id

function readProvidersDirect(profile: string): string[] | null {
  const found = new Set<string>()
  for (const [envKey, name] of ENV_PROVIDERS) {
    if (process.env[envKey]) found.add(name)
  }
  const authFile = profileAuthJsonPath(profile)
  if (existsSync(authFile)) {
    try {
      const parsed = JSON.parse(readFileSync(authFile, 'utf8')) as Record<string, unknown>
      for (const id of Object.keys(parsed ?? {})) {
        if (id && !id.startsWith('mcp_')) found.add(providerLabel(id))
      }
    } catch { /* ignore malformed auth.json */ }
  }
  const dbFile = profileDbPath(profile)
  if (!existsSync(dbFile)) return [...found]
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    db.exec('pragma query_only = on')
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name?: string }[])
        .map((r) => r.name).filter((n): n is string => typeof n === 'string'),
    )
    if (tables.has('credential')) {
      const rows = db.prepare('SELECT DISTINCT integration_id FROM credential WHERE active = 1').all() as { integration_id?: unknown }[]
      for (const r of rows) {
        if (typeof r.integration_id === 'string' && r.integration_id && !r.integration_id.startsWith('mcp_')) {
          found.add(providerLabel(r.integration_id))
        }
      }
    }
    if (tables.has('account')) {
      const row = db.prepare('SELECT count(*) AS n FROM account').get() as { n?: number } | undefined
      if ((row?.n ?? 0) > 0) found.add('OpenCode')
    }
    if (tables.has('control_account')) {
      const row = db.prepare('SELECT count(*) AS n FROM control_account WHERE active = 1').get() as { n?: number } | undefined
      if ((row?.n ?? 0) > 0) found.add('OpenCode')
    }
    return [...found]
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

const providerListCache = new Map<string, { sig: string; at: number; names: string[] }>()

/** The providers a profile has signed in to (API keys, OAuth), by name. */
export async function providers(profile: string): Promise<string[]> {
  const sig = profileAuthSignature(profile)
  const hit = providerListCache.get(profile)
  if (hit && hit.sig === sig && Date.now() - hit.at < 10 * 60_000) return hit.names
  const direct = readProvidersDirect(profile)
  if (direct !== null) {
    providerListCache.set(profile, { sig, at: Date.now(), names: direct })
    return direct
  }
  const out = await opencode(profile, ['auth', 'list', '--format', 'json']).catch(() => '[]')
  let list: unknown
  try {
    list = JSON.parse(out)
  } catch {
    return []
  }
  // [{ id, name, connections: [...] }] in 2.2.5: what has at least one connection (a key, an account, an env variable).
  const names = (Array.isArray(list) ? list : []).filter((e) => !Array.isArray((e as { connections?: unknown })?.connections) || (e as { connections: unknown[] }).connections.length > 0).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>
    return [o.name, o.provider, o.providerID, o.integration, o.id].find((v) => typeof v === 'string') as string | undefined
  })
  const unique = [...new Set(names.filter((n): n is string => !!n))]
  providerListCache.set(profile, { sig, at: Date.now(), names: unique })
  return unique
}

const MODELS_TTL_MS = 10 * 60_000
const MODELS_STALE_MS = 24 * 60 * 60_000
const modelsDiskPath = (profile: string) => join(homedir(), '.cache', 'devdash', `opencode-models-${profile}.json`)
const modelsMemCache = new Map<string, { key: string; at: number; models: Promise<string[]>; refreshing?: Promise<void> }>()

function readModelsDiskCache(profile: string, expectedKey: string): { at: number; models: string[] } | undefined {
  try {
    const uid = process.getuid?.()
    if (uid === undefined || uid < 1000 || uid >= 65534) return undefined
    const file = modelsDiskPath(profile)
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { key?: string; at?: number; models?: unknown }
    const now = Date.now()
    if (parsed.key !== expectedKey || typeof parsed.at !== 'number' || parsed.at > now + 5_000 || now - parsed.at >= MODELS_STALE_MS) return undefined
    if (!Array.isArray(parsed.models) || !parsed.models.every((m) => typeof m === 'string')) return undefined
    return { at: parsed.at, models: parsed.models as string[] }
  } catch {
    return undefined
  }
}

function writeModelsDiskCache(profile: string, key: string, list: string[]): void {
  if (!list.length) return
  try {
    const uid = process.getuid?.()
    if (uid === undefined || uid < 1000 || uid >= 65534) return
    const file = modelsDiskPath(profile)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ key, at: Date.now(), models: list }), { mode: 0o600, flag: 'wx' })
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  } catch { /* best-effort cache */ }
}

async function fetchModelsCli(profile: string, key: string): Promise<string[]> {
  const out = await opencode(profile, ['models'], 45_000).catch(() => '')
  const list = out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l))
  writeModelsDiskCache(profile, key, list)
  return list
}

/** Every model the profile can use, as provider/model ids. */
export async function models(profile: string): Promise<string[]> {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  const key = `${binSignature()}|${profile}|${profileAuthSignature(profile)}`
  const now = Date.now()
  let hit = modelsMemCache.get(profile)
  if (!hit || hit.key !== key) {
    const disk = readModelsDiskCache(profile, key)
    if (disk) {
      hit = { key, at: disk.at, models: Promise.resolve(disk.models) }
      modelsMemCache.set(profile, hit)
    }
  }
  if (hit && hit.key === key) {
    const age = now - hit.at
    if (age < MODELS_TTL_MS) return hit.models
    if (age < MODELS_STALE_MS) {
      if (!hit.refreshing) {
        const entry = hit
        const p = fetchModelsCli(profile, key).then((list) => {
          modelsMemCache.set(profile, { key, at: Date.now(), models: Promise.resolve(list) })
        }).catch(() => {}).finally(() => {
          if (entry.refreshing === p) entry.refreshing = undefined
        })
        entry.refreshing = p
      }
      return hit.models
    }
  }
  const pending = fetchModelsCli(profile, key)
  modelsMemCache.set(profile, { key, at: now, models: pending })
  void pending.catch(() => { if (modelsMemCache.get(profile)?.models === pending) modelsMemCache.delete(profile) })
  return pending
}

export function invalidateCache(): void {
  versionCache = undefined
  providerListCache.clear()
  modelsMemCache.clear()
}

type Rule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }
const rule = (action: string, effect: Rule['effect']): Rule => ({ action, resource: '*', effect })
/**
 * In the CLI nobody but the person at the terminal decides, so OpenCode asks as the session's permission mode would:
 * Bypass runs everything, Accept edits asks before commands, Ask (and Plan) before anything that changes something.
 * (The CLI is only for the owner and people with full access, so there is no guest gate to keep.)
 */
export function cliPermissions(mode: string): Rule[] {
  if (mode === 'bypassPermissions' || mode === 'dontAsk' || mode === 'auto') return [rule('*', 'allow')]
  if (mode === 'acceptEdits') return [rule('*', 'allow'), rule('shell', 'ask')]
  // devdash_notify: DevDash's notify tool (OpenCode names MCP tools <server>_<tool>); asking first would defeat it.
  return [rule('*', 'ask'), ...['read', 'glob', 'grep', 'websearch', 'skill', 'question', 'subagent', 'devdash_notify'].map((a) => rule(a, 'allow'))]
}

/**
 * The session's config. In Chat every tool asks, so DevDash decides each call (harness.ts): the session's permission
 * mode, and the guest gate in a teammate's turn; in the CLI, `cliMode` says how. DevDash's rules go in as instructions. MCP servers are named here rather than
 * passed over ACP, so the CLI gets them too, and their tools are called directly rather than through OpenCode's code
 * mode, where neither the step list nor the gate could see them.
 */
export function config(o: { rulesFile: string; mcp: Record<string, { type: 'local'; command: string[]; environment: Record<string, string> } | { type: 'remote'; url: string }>; cliMode?: string; noTools?: boolean; hideSkills?: string[] }) {
  return {
    // noTools: a one-off answer (harness.ts complete), which may use nothing. hideSkills: My skills meant for other
    // folders (skill-scope.ts); a denied skill isn't even listed, and the last matching rule wins, so these go last.
    permissions: [
      ...(o.noTools ? [rule('*', 'deny')] : o.cliMode ? cliPermissions(o.cliMode) : [rule('*', 'ask')]),
      ...(o.hideSkills ?? []).map((name): Rule => ({ action: 'skill', resource: name, effect: 'deny' })),
    ],
    instructions: [o.rulesFile],
    update: 'disable', // the install is root's: deploy/opencode-update.sh updates it for everyone
    experimental: { todo: true }, // a to-do list, shown beside the conversation
    mcp: { servers: Object.fromEntries(Object.entries(o.mcp).map(([name, s]) => [name, { ...s, codemode: false }])) },
    // In Chat DevDash drives OpenCode and knows its status; in the CLI the plugin tells it.
    ...(o.cliMode ? { plugins: [PLUGIN_DIR] } : {}),
  }
}

/**
 * OpenCode's own commands, offered before a session has said which it has (it reports its list, the project's and the
 * member's custom commands included, once it starts). A prompt that starts with one runs it.
 */
export const COMMANDS = [
  { name: 'init', description: 'Guided AGENTS.md setup' },
  { name: 'review', description: 'Review changes, defaults to uncommitted', argumentHint: '[commit|branch|pr]' },
  { name: 'goal', description: 'Keep working until an objective is met', argumentHint: '<objective> | pause | resume | clear' },
  { name: 'compact', description: 'Compact the session' },
]

export const acpArgs = ['acp']
/** Its terminal app on the same session. */
export const cliArgs = (nativeId: string) => [STANDALONE, '--session', nativeId]
/**
 * Its own sign-in, in a terminal tab: `login` picks any provider; `acct` is the OpenCode account (its Console plans, a
 * code to enter on any device), `go` the OpenCode Go subscription's key. Every one works from a server's terminal, except
 * browser sign-ins that return to this machine (Sign in with ChatGPT): harness.ts finishSignIn takes their last step.
 */
export const SIGN_INS: Record<string, string | null> = { login: null, acct: 'opencode', go: 'opencode-go' }
export const loginArgs = (target: string | null) => ['auth', 'login', ...(target ? [target] : []), STANDALONE]
/** OpenCode's agents for DevDash's permission modes: Plan reads and plans, the rest build. */
export const modeFor = (permissionMode: string) => (permissionMode === 'plan' ? 'plan' : 'build')
