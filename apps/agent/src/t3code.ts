// T3 Code's own MCP integration. Credentials belong to the DevDash member; the configured T3 server runs the tools.
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { assertRegularMemberUid } from './t3-local.ts'
import {
  assertMemberOwnedRegularFile,
  disposeSupervisorWorkers,
  isAntigravityCliBinary,
  supervisorModels,
  validateAntigravitySettingsFile,
  type SupervisorModel,
  type SupervisorProvider,
  type SupervisorTarget,
} from './t3-supervisor.ts'
import { T3Client, configPath, readConfig, type T3CallOptions } from './t3-client.ts'

type Model = { id: string; label?: string | null; options?: { id: string; values: (string | boolean)[] }[] | null }
export type Capabilities = {
  runtimeMode: string
  providers: { providerInstanceId: string; driverKind?: string; canRunChildTask: boolean; displayName: string | null; runtimeModes?: string[]; models: Model[]; omittedModels?: number }[]
}
export const installed = () => existsSync(configPath())
export const modelId = (instance: string, model: string) => `${instance}/${model}`
export function selection(value: string) {
  const split = value.indexOf('/')
  if (split < 1 || !value.slice(split + 1)) throw new Error('Choose a T3 Code provider/model from the model list.')
  return { instanceId: value.slice(0, split), model: value.slice(split + 1) }
}
/** The MCP catalog exposes native option IDs and values. Each driver names its reasoning control. */
export function effortOption(model: Model | undefined) {
  const opt = model?.options?.find((o) => /reasoning.*effort|thinking[_-]?level|thought[_-]?level|^(effort|variant)$/i.test(o.id))
  if (!opt) return undefined
  return { id: opt.id, levels: opt.values.filter((v): v is string => typeof v === 'string' && v !== 'default') }
}
/** T3's runnable flag includes enabled state, executable availability and authentication checks.
 * Its catalog also contains disabled providers and their models, which must not be offered as connected. */
export function configRevision(): string {
  try {
    const file = configPath()
    const st = statSync(file)
    return `${file}:${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

export function settingsRevision(): string {
  const rev = configRevision()
  if (!rev) return ''
  try {
    const { baseDir } = readConfig()
    if (!baseDir) return rev
    const st = statSync(join(baseDir, 'userdata', 'settings.json'))
    return `${rev}|${st.mtimeMs}:${st.size}`
  } catch {
    return rev
  }
}

export function cachesSignature(): string {
  try {
    const { baseDir } = readConfig()
    if (!baseDir) return ''
    const dir = join(baseDir, 'caches')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('-probe.json')).sort()
    return files.map((f) => {
      try {
        const st = statSync(join(dir, f))
        return `${f}:${st.mtimeMs}:${st.size}`
      } catch {
        return f
      }
    }).join(',')
  } catch {
    return ''
  }
}

const SHARED_CLIENT_IDLE_MS = 5 * 60_000
type SharedClientEntry = { key: string; generation: number; client: T3Client; ready: boolean; idleTimer?: ReturnType<typeof setTimeout> }
let sharedClient: SharedClientEntry | undefined

function closeSharedClient(entry = sharedClient) {
  if (!entry) return
  if (sharedClient === entry) sharedClient = undefined
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined }
  void entry.client.close()
}

function touchSharedClient(entry: SharedClientEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  if (sharedClient !== entry) return
  entry.idleTimer = setTimeout(() => closeSharedClient(entry), SHARED_CLIENT_IDLE_MS)
  entry.idleTimer.unref?.()
}

function acquireSharedClient(): { entry: SharedClientEntry; reused: boolean } {
  const key = configRevision()
  if (sharedClient && sharedClient.key === key && sharedClient.generation === generation) {
    return { entry: sharedClient, reused: sharedClient.ready }
  }
  closeSharedClient()
  const entry: SharedClientEntry = { key, generation, client: new T3Client(), ready: false }
  sharedClient = entry
  return { entry, reused: false }
}

process.once('exit', () => {
  if (sharedClient?.idleTimer) clearTimeout(sharedClient.idleTimer)
  sharedClient = undefined
})

export async function connectedCapabilities(client: T3Client, search?: string, options?: T3CallOptions): Promise<Capabilities> {
  const capabilities = await client.call<Capabilities>('orchestrator_capabilities', search ? { search } : {}, options)
  return { ...capabilities, providers: capabilities.providers.filter((p) => p.canRunChildTask === true) }
}

const CAPS_FRESH_MS = 2 * 60_000
const CAPS_STALE_MS = 60 * 60_000
const fullCapsDiskCachePath = () => join(homedir(), '.cache', 'devdash', 't3-capabilities-cache.json')

type FullCapsEntry = {
  key: string
  diskKey: string
  cachesSig: string
  at: number
  version: string | null
  capabilities: Capabilities
}
let fullCapsCache: FullCapsEntry | undefined
let fullCapsRefreshing: Promise<{ version: string | null; capabilities: Capabilities }> | undefined

function isValidCapabilities(v: unknown): v is Capabilities {
  if (!isPlainObject(v) || typeof v.runtimeMode !== 'string' || !Array.isArray(v.providers)) return false
  return v.providers.every((p) =>
    isPlainObject(p) && typeof p.providerInstanceId === 'string' && typeof p.canRunChildTask === 'boolean' && Array.isArray(p.models)
    && p.models.every((m) => isPlainObject(m) && typeof m.id === 'string')
  )
}

function readFullCapsDiskCache(expectedDiskKey: string): Omit<FullCapsEntry, 'key'> | undefined {
  if (!expectedDiskKey) return undefined
  try {
    const uid = assertRegularMemberUid(process.getuid?.())
    const file = fullCapsDiskCachePath()
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      diskKey?: string; cachesSig?: string; at?: number; version?: unknown; capabilities?: unknown
    }
    const now = Date.now()
    if (parsed.diskKey !== expectedDiskKey || typeof parsed.at !== 'number' || parsed.at > now + 5_000 || now - parsed.at >= CAPS_STALE_MS) return undefined
    if (parsed.version !== null && typeof parsed.version !== 'string') return undefined
    if (!isValidCapabilities(parsed.capabilities)) return undefined
    return {
      diskKey: expectedDiskKey,
      cachesSig: typeof parsed.cachesSig === 'string' ? parsed.cachesSig : '',
      at: parsed.at,
      version: parsed.version,
      capabilities: parsed.capabilities,
    }
  } catch {
    return undefined
  }
}

function writeFullCapsDiskCache(entry: Omit<FullCapsEntry, 'key'>): void {
  if (!entry.diskKey) return
  try {
    assertRegularMemberUid(process.getuid?.())
    const file = fullCapsDiskCachePath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({
        diskKey: entry.diskKey,
        cachesSig: entry.cachesSig,
        at: entry.at,
        version: entry.version,
        capabilities: entry.capabilities,
      }), { mode: 0o600, flag: 'wx' })
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  } catch { /* best-effort cache */ }
}

function clearFullCapsDiskCache(): void {
  try { unlinkSync(fullCapsDiskCachePath()) } catch { /* ignore */ }
}

async function fetchInspectLive(budgetMs: number, search: string | undefined, full: boolean) {
  const started = generation
  const rev = configRevision()
  const diskKey = settingsRevision()
  const cachesSig = cachesSignature()
  const cacheKey = `${started}:${diskKey}`
  const deadline = Date.now() + budgetMs
  const runOnce = async (entry: SharedClientEntry) => {
    const remaining = Math.max(1, deadline - Date.now())
    const opts: T3CallOptions = { timeoutMs: remaining, signal: AbortSignal.timeout(remaining) }
    await entry.client.connect(opts)
    const capabilities = await connectedCapabilities(entry.client, search, opts)
    if (full && !search) await expandShortlists(entry.client, capabilities, opts)
    entry.ready = true
    touchSharedClient(entry)
    return { version: entry.client.serverVersion, capabilities }
  }
  const { entry, reused } = acquireSharedClient()
  let result: { version: string | null; capabilities: Capabilities }
  try {
    result = await runOnce(entry)
  } catch (err) {
    closeSharedClient(entry)
    if (!reused || Date.now() >= deadline - 100) throw err
    // A warm MCP session can expire if T3 Code restarts; retry once on a fresh session for read-only discovery.
    const fresh = acquireSharedClient().entry
    try {
      result = await runOnce(fresh)
    } catch (retryErr) {
      closeSharedClient(fresh)
      throw retryErr
    }
  }
  if (generation === started && !search) {
    const now = Date.now()
    capsCache = { key: `${started}:${rev}`, at: now, capabilities: result.capabilities }
    if (full) {
      const next: FullCapsEntry = { key: cacheKey, diskKey, cachesSig, at: now, version: result.version, capabilities: result.capabilities }
      fullCapsCache = next
      writeFullCapsDiskCache(next)
    }
  }
  return result
}

export async function inspect(budgetMs = 5000, search?: string, full = false) {
  if (full && !search) {
    const diskKey = settingsRevision()
    const cacheKey = `${generation}:${diskKey}`
    if (!fullCapsCache || fullCapsCache.key !== cacheKey) {
      const disk = readFullCapsDiskCache(diskKey)
      if (disk) fullCapsCache = { key: cacheKey, ...disk }
    }
    if (fullCapsCache && fullCapsCache.key === cacheKey) {
      const age = Date.now() - fullCapsCache.at
      if (age < CAPS_STALE_MS) {
        const stale = age >= CAPS_FRESH_MS || fullCapsCache.cachesSig !== cachesSignature()
        if (stale && !fullCapsRefreshing) {
          const p = fetchInspectLive(budgetMs, undefined, true).finally(() => {
            if (fullCapsRefreshing === p) fullCapsRefreshing = undefined
          })
          fullCapsRefreshing = p
          void p.catch(() => {})
        }
        return { version: fullCapsCache.version, capabilities: fullCapsCache.capabilities }
      }
    }
    if (fullCapsRefreshing) return fullCapsRefreshing
    const p = fetchInspectLive(budgetMs, undefined, true).finally(() => {
      if (fullCapsRefreshing === p) fullCapsRefreshing = undefined
    })
    fullCapsRefreshing = p
    return p
  }
  return fetchInspectLive(budgetMs, search, full)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveAntigravityBinary(baseDir: string, config: Record<string, unknown>, uid: number): { bin: string; harnessPath?: string } | undefined {
  let bin: string | undefined
  if (config.binaryPath !== undefined) {
    if (typeof config.binaryPath !== 'string' || !isAbsolute(config.binaryPath)) return undefined
    bin = config.binaryPath
  } else {
    const toolRoot = join(baseDir, 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`)
    const activePath = join(toolRoot, 'active.json')
    try {
      assertMemberOwnedRegularFile(activePath, uid)
      const active = JSON.parse(readFileSync(activePath, 'utf8')) as unknown
      if (!isPlainObject(active)) return undefined
      const releaseId = active.releaseId
      if (typeof releaseId !== 'string' || !/^[a-f0-9]{16,128}$/i.test(releaseId)) return undefined
      const versionDir = join(toolRoot, 'versions', releaseId)
      const dirStat = lstatSync(versionDir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== uid) return undefined
      const recordPath = join(versionDir, '.install-complete.json')
      if (existsSync(recordPath)) {
        assertMemberOwnedRegularFile(recordPath, uid)
        const record = JSON.parse(readFileSync(recordPath, 'utf8')) as unknown
        if (!isPlainObject(record) || record.releaseId !== releaseId || !isPlainObject(record.executable)) return undefined
        const execName = record.executable.name
        if (execName !== 'antigravity' && execName !== 'agy_acp_server.par') return undefined
        const candidate = join(versionDir, execName)
        const binStat = lstatSync(candidate)
        if (!binStat.isFile() || binStat.isSymbolicLink() || binStat.uid !== uid) return undefined
        bin = candidate
      } else {
        const candidate = join(versionDir, 'agy_acp_server.par')
        const binStat = lstatSync(candidate)
        if (!binStat.isFile() || binStat.isSymbolicLink() || binStat.uid !== uid) return undefined
        bin = candidate
      }
    } catch {
      return undefined
    }
  }
  if (!isExecutableFile(bin)) return undefined
  const siblingHarness = join(dirname(bin), 'localharness_external')
  const harnessPath = isExecutableFile(siblingHarness) ? siblingHarness : undefined
  return { bin, harnessPath }
}

/** Reuse only member-owned provider instances whose driver can guarantee hard tool-free execution:
 * - OpenCode: stateless /api/experimental/generate/text with deny-all policies & per-run auth
 * - Antigravity: ephemeral ACP server with clientCapabilities fs/terminal=false, mcpServers=[], enabledTools=[], isolated HOME/GEMINI_HOME
 * Drivers like Codex keep built-in exec/collaboration tools enabled even with read-only sandboxes and stay chat-only. */
function supervisorProviders(providers: Capabilities['providers']): Map<string, SupervisorProvider> {
  const result = new Map<string, SupervisorProvider>()
  const { baseDir } = readConfig()
  if (!baseDir) return result
  try {
    const uid = assertRegularMemberUid(process.getuid?.())
    const settingsFile = join(baseDir, 'userdata', 'settings.json')
    assertMemberOwnedRegularFile(settingsFile, uid)
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { providerInstances?: Record<string, unknown> }
    if (!isPlainObject(settings.providerInstances)) return result

    for (const p of providers) {
      const instance = settings.providerInstances[p.providerInstanceId]
      if (!isPlainObject(instance) || instance.enabled === false) continue
      if (Object.keys(instance).some((k) => !['driver', 'enabled', 'config', 'displayName'].includes(k))) continue
      const config = instance.config === undefined ? {} : instance.config
      if (!isPlainObject(config) || config.enabled === false) continue

      if (p.driverKind === 'opencode' && instance.driver === 'opencode') {
        if (Object.keys(config).some((k) => !['binaryPath', 'customModels', 'enabled'].includes(k))) continue
        const bin = config.binaryPath
        if (typeof bin !== 'string' || !isAbsolute(bin) || !isExecutableFile(bin)) continue
        result.set(p.providerInstanceId, { kind: 'opencode', key: `opencode:${bin}`, bin })
        continue
      }

      if (p.driverKind === 'antigravity' && instance.driver === 'antigravity') {
        if (Object.keys(config).some((k) => !['enabled', 'authMethod', 'binaryPath', 'customModels'].includes(k))) continue
        if (config.authMethod !== undefined && config.authMethod !== 'oauth-personal') continue
        const resolved = resolveAntigravityBinary(baseDir, config, uid)
        if (!resolved) continue
        const providerHash = createHash('sha256').update(p.providerInstanceId).digest('hex')
        const acpDir = join(baseDir, 'userdata', 'providers', 'antigravity', providerHash, 'antigravity-acp')
        const tokenPath = join(acpDir, isAntigravityCliBinary(resolved.bin) ? 'antigravity-oauth-token' : 'acp_token.json')
        const agySettingsPath = join(acpDir, 'settings.json')
        try {
          assertMemberOwnedRegularFile(tokenPath, uid)
          let settingsPath: string | undefined
          let fileAuthType: 'oauth-personal' | undefined
          if (existsSync(agySettingsPath)) {
            fileAuthType = validateAntigravitySettingsFile(agySettingsPath, uid)
            settingsPath = agySettingsPath
          }
          if (config.authMethod === undefined && fileAuthType !== 'oauth-personal') continue
          result.set(p.providerInstanceId, {
            kind: 'antigravity',
            key: `antigravity:${resolved.bin}:${resolved.harnessPath ?? ''}:${tokenPath}`,
            bin: resolved.bin,
            ...(resolved.harnessPath ? { harnessPath: resolved.harnessPath } : {}),
            authMethod: 'oauth-personal',
            tokenPath,
            ...(settingsPath ? { settingsPath } : {}),
          })
        } catch { /* An unverified Antigravity instance doesn't affect the member's other instances. */ }
      }
    }
  } catch { /* Other T3 chat models remain available without local provider configuration. */ }
  return result
}

// The MCP response is a shortlist. The member's T3 discovery snapshot supplies omitted IDs;
// exact live lookup confirms each before it can enter a picker.
async function expandShortlists(client: T3Client, caps: Capabilities, options?: T3CallOptions) {
  const { baseDir } = readConfig()
  if (!baseDir) return
  const groups: { provider: Capabilities['providers'][number]; ids: string[]; found: (Model | undefined)[] }[] = []
  const queue: { groupIdx: number; itemIdx: number; providerInstanceId: string; id: string }[] = []
  for (const provider of caps.providers) {
    if (!provider.omittedModels || !/^[\w.-]+$/.test(provider.providerInstanceId)) continue
    try {
      const snapshot = JSON.parse(readFileSync(join(baseDir, 'caches', provider.providerInstanceId + '.json'), 'utf8'))
      if (snapshot.instanceId !== provider.providerInstanceId || snapshot.driver !== provider.driverKind) continue
      const ids = snapshot.models.map((m: { slug: string }) => m.slug).filter((id: string) => typeof id === 'string' && !provider.models.some((m) => m.id === id))
      if (!ids.length) continue
      const groupIdx = groups.length
      groups.push({ provider, ids, found: new Array<Model | undefined>(ids.length) })
      ids.forEach((id: string, itemIdx: number) => queue.push({ groupIdx, itemIdx, providerInstanceId: provider.providerInstanceId, id }))
    } catch { continue }
  }
  if (!queue.length) return
  let cursor = 0
  const concurrency = Math.min(16, queue.length)
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < queue.length) {
      const task = queue[cursor++]!
      try {
        const exact = await connectedCapabilities(client, task.id, options)
        const model = exact.providers.find((p) => p.providerInstanceId === task.providerInstanceId)?.models.find((m) => m.id === task.id)
        if (model) groups[task.groupIdx]!.found[task.itemIdx] = model
      } catch { /* ignore individual omitted lookup error */ }
    }
  }))
  for (const g of groups) {
    for (const model of g.found) if (model) g.provider.models.push(model)
  }
}

const CATALOG_TTL_MS = 10 * 60_000
const CATALOG_STALE_MS = 24 * 60 * 60_000
const openCodeDiskCachePath = () => join(homedir(), '.cache', 'devdash', 't3-opencode-catalog.json')

function openCodeCacheKey(bin: string): string | undefined {
  try {
    const st = statSync(bin)
    return `${bin}:${st.mtimeMs}:${st.size}:${configRevision()}`
  } catch {
    return undefined
  }
}

function readOpenCodeDiskCache(bin: string): { at: number; models: SupervisorModel[] } | undefined {
  const expectedKey = openCodeCacheKey(bin)
  if (!expectedKey) return undefined
  try {
    const uid = assertRegularMemberUid(process.getuid?.())
    const file = openCodeDiskCachePath()
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { key?: string; at?: number; models?: unknown }
    const now = Date.now()
    if (parsed.key !== expectedKey || typeof parsed.at !== 'number' || parsed.at > now + 5_000 || now - parsed.at >= CATALOG_STALE_MS) return undefined
    if (!Array.isArray(parsed.models)) return undefined
    const valid = parsed.models.every((m) =>
      m && typeof m === 'object' && typeof (m as SupervisorModel).id === 'string'
      && Array.isArray((m as SupervisorModel).variants) && (m as SupervisorModel).variants.every((v) => typeof v === 'string')
      && ((m as SupervisorModel).displayName === undefined || typeof (m as SupervisorModel).displayName === 'string')
    )
    return valid ? { at: parsed.at, models: parsed.models as SupervisorModel[] } : undefined
  } catch {
    return undefined
  }
}

function writeOpenCodeDiskCache(bin: string, models: SupervisorModel[]): void {
  const key = openCodeCacheKey(bin)
  if (!key) return
  try {
    assertRegularMemberUid(process.getuid?.())
    const file = openCodeDiskCachePath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ key, at: Date.now(), models }), { mode: 0o600, flag: 'wx' })
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  } catch { /* best-effort cache */ }
}

function clearOpenCodeDiskCache(): void {
  try { unlinkSync(openCodeDiskCachePath()) } catch { /* ignore */ }
}

const catalogCache = new Map<string, { at: number; models: ReturnType<typeof supervisorModels>; refreshing?: Promise<void> }>()
function refreshNativeCatalogInBackground(provider: SupervisorProvider, entry: { at: number; models: ReturnType<typeof supervisorModels>; refreshing?: Promise<void> }) {
  const started = generation
  const p = supervisorModels(provider).then((list) => {
    if (generation !== started) return
    if (provider.kind === 'opencode') writeOpenCodeDiskCache(provider.bin, list)
    catalogCache.set(provider.key, { at: Date.now(), models: Promise.resolve(list) })
  }).catch(() => {}).finally(() => {
    if (entry.refreshing === p) entry.refreshing = undefined
  })
  entry.refreshing = p
}
function nativeCatalog(provider: SupervisorProvider, allowDiskCache = false) {
  const now = Date.now()
  let hit = catalogCache.get(provider.key)
  if (!hit && allowDiskCache && provider.kind === 'opencode') {
    const disk = readOpenCodeDiskCache(provider.bin)
    if (disk) {
      hit = { at: disk.at, models: Promise.resolve(disk.models) }
      catalogCache.set(provider.key, hit)
    }
  }
  if (hit) {
    const age = now - hit.at
    if (age < CATALOG_TTL_MS) return hit.models
    if (allowDiskCache && age < CATALOG_STALE_MS) {
      if (!hit.refreshing) refreshNativeCatalogInBackground(provider, hit)
      return hit.models
    }
  }
  const started = generation
  const models = supervisorModels(provider).then((list) => {
    if (generation === started && provider.kind === 'opencode') writeOpenCodeDiskCache(provider.bin, list)
    return list
  })
  catalogCache.set(provider.key, { at: now, models })
  void models.catch(() => { if (catalogCache.get(provider.key)?.models === models) catalogCache.delete(provider.key) })
  return models
}
let capsCache: { key: string; at: number; capabilities: Capabilities } | undefined
async function cachedSupervisorCapabilities(): Promise<Capabilities> {
  const key = `${generation}:${configRevision()}`
  if (capsCache && capsCache.key === key && Date.now() - capsCache.at < 60_000) return capsCache.capabilities
  const { capabilities } = await inspect(5000)
  return capabilities
}

export async function nativeVariants(caps: Capabilities, instance: string, id: string) {
  const provider = supervisorProviders(caps.providers).get(instance)
  if (!provider || provider.kind !== 'opencode') return
  const models = await nativeCatalog(provider, true).catch(() => [])
  return models.find((m) => m.id === id)?.variants
}

export async function supervisorTarget(value: string, effort?: string): Promise<SupervisorTarget> {
  const { instanceId, model } = selection(value)
  const capabilities = await cachedSupervisorCapabilities()
  const provider = supervisorProviders(capabilities.providers).get(instanceId)
  if (!provider) throw new Error('Choose an available T3 Code supervisor model.')
  if (provider.kind === 'opencode') {
    if (!/^[^/]+\/.+/.test(model)) throw new Error('Choose an available T3 Code supervisor model.')
    const { instanceId: providerID, model: id } = selection(model)
    return { kind: 'opencode', bin: provider.bin, providerID, id, ...(effort ? { variant: effort } : {}) }
  }
  return {
    kind: 'antigravity',
    bin: provider.bin,
    ...(provider.harnessPath ? { harnessPath: provider.harnessPath } : {}),
    authMethod: provider.authMethod,
    tokenPath: provider.tokenPath,
    ...(provider.settingsPath ? { settingsPath: provider.settingsPath } : {}),
    id: model,
    ...(effort ? { variant: effort } : {}),
  }
}
export async function modelChoices(search?: string, supervisor = false) {
  const { capabilities } = await inspect(15_000, search, true)
  const providers = supervisorProviders(capabilities.providers)
  const unique = new Map<string, SupervisorProvider>()
  for (const provider of providers.values()) {
    // Only probe Antigravity when building supervisor pickers so chat pickers avoid .par startup overhead.
    if (!supervisor && provider.kind !== 'opencode') continue
    if (!unique.has(provider.key)) unique.set(provider.key, provider)
  }
  const catalogs = new Map<string, Awaited<ReturnType<typeof supervisorModels>>>()
  await Promise.allSettled([...unique.values()].map(async (provider) => catalogs.set(provider.key, await nativeCatalog(provider, !supervisor))))
  const rows = capabilities.providers.flatMap((p) => {
    const provider = providers.get(p.providerInstanceId)
    const native = provider ? catalogs.get(provider.key) : undefined
    const models = new Map(p.models.map((m) => [m.id, m]))
    if (supervisor) for (const n of native ?? []) {
      if (!models.has(n.id)) models.set(n.id, { id: n.id, label: n.displayName })
    }
    return [...models.values()].map((m) => {
      const value = modelId(p.providerInstanceId, m.id)
      const match = native?.find((n) => n.id === m.id)
      return { value, displayName: m.label || m.id, description: value, group: p.providerInstanceId,
        ...(supervisor && { supportsSupervisor: !!match }), supportedEffortLevels: match?.variants ?? effortOption(m)?.levels ?? [] }
    })
  })
  // T3 does not identify the model chosen for Default. The supervisor always requires an explicit model.
  return supervisor ? rows : [{ value: '', displayName: 'Default', description: "T3 Code's own default" }, ...rows]
}
let cached: { key: string; at: number; value: Awaited<ReturnType<typeof probeInfo>> } | undefined
let probing: { key: string; value: Promise<Awaited<ReturnType<typeof probeInfo>>> } | undefined
let generation = 0
export const invalidateInfo = () => {
  generation++
  closeSharedClient()
  catalogCache.clear()
  clearOpenCodeDiskCache()
  clearFullCapsDiskCache()
  capsCache = undefined
  fullCapsCache = undefined
  fullCapsRefreshing = undefined
  cached = undefined
  probing = undefined
  void disposeSupervisorWorkers()
}
async function probeInfo() {
  try {
    const { version, capabilities } = await inspect(1500)
    return { harness: 't3code', installed: true, version, profiles: [{ name: 'default', providers: capabilities.providers.filter((p) => p.models.length).map((p) => p.displayName ?? p.providerInstanceId) }] }
  } catch {
    return { harness: 't3code', installed: false, version: null, profiles: [], error: 'Cannot connect to your member-owned T3 Code instance. Check its service and connection configuration.' }
  }
}
export async function info() {
  if (!installed()) return { harness: 't3code', installed: false, version: null, profiles: [], error: 'No member-owned T3 Code connection configured for your account.' }
  const key = configRevision()
  if (!key) return probeInfo()
  if (cached?.key === key && Date.now() - cached.at < (cached.value.installed ? 60_000 : 15_000)) return cached.value
  if (probing?.key === key) return probing.value
  const started = generation
  const value = probeInfo().then((value) => { if (generation === started) cached = { key, at: Date.now(), value }; return value }).finally(() => { if (probing?.value === value) probing = undefined })
  probing = { key, value }
  return value
}

const execFileAsync = promisify(execFile)
const SETUP_SCRIPT = fileURLToPath(new URL('../../../deploy/t3-setup.mjs', import.meta.url))

export type T3SetupKind = 'connect' | 'pair' | 'status'

/** Command launched inside a DevDash terminal tab (t3-connect / t3-pair / t3-status) as this member. */
export function setupCommand(kind: T3SetupKind) {
  return { env: {} as Record<string, string>, args: [process.execPath, SETUP_SCRIPT, kind, '--interactive'] }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

async function pickMemberPort(): Promise<number> {
  const uid = process.getuid?.() ?? 1000
  const span = 3899 - 3781 + 1
  const offset = Math.abs(uid) % span
  for (let i = 0; i < span; i++) {
    const port = 3781 + ((offset + i) % span)
    if (await portFree(port)) return port
  }
  throw new Error('No free local port available for devdash-t3 (3781-3899).')
}

/**
 * Prepares this member's private T3 Code directories and ~/.config/devdash/t3-service.env
 * strictly as the unprivileged member (so the root helper never touches paths in /home/<user>).
 */
export async function prepareService(): Promise<{ port: number; baseDir: string; url: string }> {
  const home = homedir()
  const baseDir = join(home, '.local', 'share', 'devdash-t3')
  const cfgDir = join(home, '.config', 'devdash')
  const envFile = join(cfgDir, 't3-service.env')
  mkdirSync(baseDir, { recursive: true, mode: 0o700 })
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 })

  let port: number | null = null
  if (existsSync(envFile)) {
    const st = lstatSync(envFile)
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error('~/.config/devdash/t3-service.env must be a regular file.')
    }
    const m = readFileSync(envFile, 'utf8').match(/^\s*DEVDASH_T3_PORT\s*=\s*(\d{4,5})\s*$/m)
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n >= 1024 && n <= 65535) port = n
    }
  }
  if (!port) {
    port = await pickMemberPort()
    const tmp = `${envFile}.tmp-${randomBytes(6).toString('hex')}`
    writeFileSync(tmp, `DEVDASH_T3_PORT=${port}\n`, { mode: 0o600 })
    renameSync(tmp, envFile)
  }
  return { port, baseDir, url: `http://127.0.0.1:${port}/mcp` }
}

/** Connects or renews this member's own T3 Code credential via deploy/t3-setup.mjs and refreshes capabilities. */
export async function connectMember(opts: { url?: string; baseDir?: string; t3Bin?: string } = {}) {
  const args = [SETUP_SCRIPT, 'connect', '--json']
  if (opts.url) args.push('--url', opts.url)
  if (opts.baseDir) args.push('--base-dir', opts.baseDir)
  if (opts.t3Bin) args.push('--t3-bin', opts.t3Bin)
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }))
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const msg = (e.stderr || e.message || 'Could not connect T3 Code.').trim()
    throw new Error(msg.split('\n')[0] || 'Could not connect T3 Code.')
  }
  const parsed = JSON.parse(stdout.trim()) as { config: string; expiresAt: string; renewed: boolean; revokedOld: boolean }
  invalidateInfo()
  const agent = await info()
  return { agent, expiresAt: parsed.expiresAt, renewed: parsed.renewed, revokedOld: parsed.revokedOld }
}

/** Revokes this member's DevDash OAuth session in T3 Code and removes ~/.config/devdash/t3code.json. */
export async function disconnectMember() {
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync(process.execPath, [SETUP_SCRIPT, 'disconnect', '--json'], { timeout: 20_000, maxBuffer: 1024 * 1024 }))
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const msg = (e.stderr || e.message || 'Could not disconnect T3 Code.').trim()
    throw new Error(msg.split('\n')[0] || 'Could not disconnect T3 Code.')
  }
  const parsed = JSON.parse(stdout.trim()) as { removed: boolean; revoked: boolean }
  invalidateInfo()
  return parsed
}
