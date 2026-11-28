// Per-thread real-time token & USD cost reader from this member's own T3 Code statev2.sqlite + LiteLLM rate cache.
// Strictly read-only, symlink-safe, and uid-verified against the unprivileged Linux member.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readConfig } from './t3-client.ts'
import { assertRegularMemberUid } from './t3-local.ts'

export type T3ThreadTurnUsage = {
  cost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
}

export type T3ThreadUsageSnapshot = {
  usage: T3ThreadTurnUsage
  byRunId: Record<string, T3ThreadTurnUsage>
  context: { usedTokens: number; maxTokens: number } | null
  activeModel: string | null
}

type TokenRates = {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadCostPerToken: number
  cacheCreationCostPerToken: number
}

type SpeedRates = TokenRates & {
  fast: TokenRates | null
  ultrafast: TokenRates | null
  contextTiers: { thresholdTokens: number; rate: Omit<SpeedRates, 'contextTiers'> }[]
}

type CachedRates = {
  ratesSig: string
  settingsSig: string
  table: Map<string, SpeedRates>
  overrides: Map<string, SpeedRates>
  aliases: Map<string, string>
  defaultModel: string | null
}

const FIRST_PARTY_PROVIDERS = new Set(['anthropic', 'deepseek', 'gemini', 'meta', 'mistral', 'openai', 'xai'])
const UNPRICEABLE_MODELS = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable'])
const OPENCODE_GATEWAYS = new Set(['opencode', 'opencode-go'])
const OPENCODE_LITELLM_PREFIXES = new Map<string, string>([
  ['anthropic', 'anthropic'],
  ['openai', 'openai'],
  ['google', 'gemini'],
  ['google-vertex', 'vertex_ai'],
  ['deepseek', 'deepseek'],
  ['mistral', 'mistral'],
  ['xai', 'xai'],
  ['groq', 'groq'],
  ['openrouter', 'openrouter'],
])
const CONTEXT_TIER_INPUT_KEY = /^input_cost_per_token_above_(\d{1,7})k_tokens(?:_priority|_ultrafast)?$/

const rateCacheByBaseDir = new Map<string, CachedRates>()

export function zeroThreadUsage(): T3ThreadTurnUsage {
  return { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 }
}

function resolveVerifiedBaseDir(explicitBaseDir?: string): { baseDir: string; uid: number } {
  const uid = assertRegularMemberUid(process.getuid?.())
  let rawBase = explicitBaseDir || process.env.DEVDASH_T3_BASE_DIR
  if (!rawBase) {
    try {
      rawBase = readConfig().baseDir
    } catch {
      rawBase = undefined
    }
  }
  const baseDir = resolve(rawBase || join(homedir(), '.local', 'share', 'devdash-t3'))
  const st = lstatSync(baseDir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error('T3 Code data directory must be a private (0700) directory owned by this Linux member.')
  }
  return { baseDir, uid }
}

function verifiedMemberFile(filePath: string, uid: number): { mtimeMs: number; size: number } | null {
  if (!existsSync(filePath)) return null
  const st = lstatSync(filePath)
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid) return null
  return { mtimeMs: st.mtimeMs, size: st.size }
}

function verifiedMemberDir(dirPath: string, uid: number): boolean {
  if (!existsSync(dirPath)) return false
  const st = lstatSync(dirPath)
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function normalizeRateKey(name: string): string {
  return name.trim().toLowerCase()
}

function bareModelName(key: string): string {
  const idx = key.lastIndexOf('/')
  return idx === -1 ? key : key.slice(idx + 1)
}

function bedrockBaseModelName(key: string): string {
  let s = key.replace(/^(?:global|us|eu|apac)\./, '')
  s = s.replace(/^(?:anthropic|amazon|meta|mistral|cohere|deepseek|openai)\./, '')
  s = s.replace(/-v\d+(?::\d+)?$/, '')
  return s
}

function readTokenRates(entry: Record<string, unknown>, suffix: string, standard?: TokenRates, outputFallback?: number): TokenRates | null {
  const input = finiteNumber(entry[`input_cost_per_token${suffix}`])
  const output = finiteNumber(entry[`output_cost_per_token${suffix}`]) ?? outputFallback ?? null
  if (input === null || output === null) return null
  const cacheRate = (name: string, field: keyof TokenRates, fallback = input) =>
    finiteNumber(entry[`${name}${suffix}`])
    ?? (standard !== undefined && standard.inputCostPerToken > 0
      ? (standard[field] / standard.inputCostPerToken) * input
      : fallback)
  const cacheCreationCostPerToken = cacheRate('cache_creation_input_token_cost', 'cacheCreationCostPerToken')
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate('cache_read_input_token_cost', 'cacheReadCostPerToken'),
    cacheCreationCostPerToken,
  }
}

function scaleTokenRates(rates: TokenRates, mult: number): TokenRates {
  return {
    inputCostPerToken: rates.inputCostPerToken * mult,
    outputCostPerToken: rates.outputCostPerToken * mult,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * mult,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * mult,
  }
}

function readSpeedRates(entry: Record<string, unknown>, standard: TokenRates, suffix = ''): Omit<SpeedRates, 'contextTiers'> {
  const specific = entry.provider_specific_entry
  const fastMult = specific && typeof specific === 'object' ? finiteNumber((specific as Record<string, unknown>).fast) : null
  return {
    ...standard,
    fast: fastMult !== null && fastMult > 0
      ? scaleTokenRates(standard, fastMult)
      : readTokenRates(entry, `${suffix}_priority`, standard),
    ultrafast: readTokenRates(entry, `${suffix}_ultrafast`, standard),
  }
}

function readContextTiers(entry: Record<string, unknown>, base: TokenRates) {
  const thresholds = new Set<string>()
  for (const key of Object.keys(entry)) {
    const m = CONTEXT_TIER_INPUT_KEY.exec(key)
    if (m?.[1]) thresholds.add(m[1])
  }
  return [...thresholds]
    .map((t) => {
      const suffix = `_above_${t}k_tokens`
      const standard = readTokenRates(entry, suffix, base, base.outputCostPerToken) ?? base
      return {
        thresholdTokens: Number(t) * 1000,
        rate: readSpeedRates(entry, standard, suffix),
      }
    })
    .sort((a, b) => b.thresholdTokens - a.thresholdTokens)
}

function sameTokenRates(a: TokenRates | null, b: TokenRates | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.inputCostPerToken === b.inputCostPerToken
    && a.outputCostPerToken === b.outputCostPerToken
    && a.cacheReadCostPerToken === b.cacheReadCostPerToken
    && a.cacheCreationCostPerToken === b.cacheCreationCostPerToken
  )
}

export function parseLiteLLMRateTable(document: unknown): Map<string, SpeedRates> {
  const table = new Map<string, SpeedRates>()
  if (!document || typeof document !== 'object') return table
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const standard = readTokenRates(entry, '')
    if (!standard) continue
    const key = normalizeRateKey(name)
    if (!key) continue
    table.set(key, {
      ...readSpeedRates(entry, standard),
      contextTiers: readContextTiers(entry, standard),
    })
  }
  const aliasCandidates = new Map<string, { rate: SpeedRates | null; firstParty: boolean }>()
  for (const [key, rate] of table) {
    const slash = key.indexOf('/')
    const alias = slash === -1 ? bedrockBaseModelName(key) : bareModelName(key)
    if (!alias || alias === key || table.has(alias)) continue
    const firstParty = slash !== -1 && FIRST_PARTY_PROVIDERS.has(key.slice(0, slash))
    const held = aliasCandidates.get(alias)
    if (!held || (firstParty && !held.firstParty)) {
      aliasCandidates.set(alias, { rate, firstParty })
    } else if (held.rate !== null && firstParty === held.firstParty) {
      if (!sameTokenRates(held.rate, rate)) {
        aliasCandidates.set(alias, { rate: null, firstParty })
      }
    }
  }
  for (const [alias, { rate }] of aliasCandidates) {
    if (rate !== null) table.set(alias, rate)
  }
  return table
}

export function antigravityRateModel(model: string): string {
  const base = model.replace(/-(?:extra-low|low|medium|high|tiered|control|thinking|agent|orchestrator|trial|n|r)$/, '')
  if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)) return 'gemini-3.5-flash'
  if (model === 'gemini-3.7-flash-safety-le') return 'gemini-3.7-flash'
  if (model === 'gemini-pro-orchestrator-neon') return 'gemini-4-neon'
  if (model === 'gemini-pro-orchestrator-g1-pro') return 'gemini-4-argon'
  if (model === 'gemini-pro-orchestrator') return 'gemini-4-carbon'
  if (base === 'gemini-3-flash') return 'gemini-3-flash-preview'
  return base
}

function lookupRate(table: Map<string, SpeedRates>, rawModel: string): SpeedRates | null {
  const key = normalizeRateKey(rawModel)
  const bare = bareModelName(key)
  if (!bare || UNPRICEABLE_MODELS.has(bare)) return null
  return table.get(key) ?? table.get(bare) ?? null
}

function selectRatesAt(
  rate: SpeedRates,
  speed: 'standard' | 'fast' | 'ultrafast',
  contextWindowTokens: number,
): TokenRates {
  let chosen: Omit<SpeedRates, 'contextTiers'> = rate
  if (contextWindowTokens > 0) {
    for (const tier of rate.contextTiers) {
      if (contextWindowTokens > tier.thresholdTokens) {
        chosen = tier.rate
        break
      }
    }
  }
  if (speed === 'fast' && chosen.fast) return chosen.fast
  if (speed === 'ultrafast' && chosen.ultrafast) return chosen.ultrafast
  return chosen
}

export function priceTurnTokens(opts: {
  driver: string
  model: string | null
  speed?: 'standard' | 'fast' | 'ultrafast'
  contextTokens?: number
  uncachedInputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  table: Map<string, SpeedRates>
  overrides?: Map<string, SpeedRates>
  aliases?: Map<string, string>
}): number {
  const rawModel = opts.model?.trim()
  if (!rawModel) return 0
  if (opts.driver === 'opencode') {
    const slash = rawModel.indexOf('/')
    const gw = slash !== -1 ? rawModel.slice(0, slash) : ''
    if (OPENCODE_GATEWAYS.has(gw) && rawModel.endsWith('-free')) return 0
  }
  const aliased = opts.aliases?.get(rawModel) ?? rawModel
  const override = opts.overrides?.get(rawModel)
    ?? opts.overrides?.get(`${opts.driver}:${rawModel}`)
    ?? opts.overrides?.get(aliased)
  let rate: SpeedRates | null = override ?? lookupRate(opts.table, aliased)
  if (!rate && opts.driver === 'antigravity') {
    rate = lookupRate(opts.table, antigravityRateModel(aliased))
  }
  if (!rate && opts.driver === 'opencode' && aliased.includes('/')) {
    const slash = aliased.indexOf('/')
    const prov = aliased.slice(0, slash)
    const rest = aliased.slice(slash + 1)
    const prefix = OPENCODE_LITELLM_PREFIXES.get(prov)
    rate = (prefix ? lookupRate(opts.table, `${prefix}/${rest}`) : null) ?? lookupRate(opts.table, rest)
  }
  if (!rate) return 0
  const r = selectRatesAt(rate, opts.speed ?? 'standard', opts.contextTokens ?? 0)
  return (
    opts.uncachedInputTokens * r.inputCostPerToken
    + opts.cachedInputTokens * r.cacheReadCostPerToken
    + opts.cacheCreationTokens * r.cacheCreationCostPerToken
    + opts.outputTokens * r.outputCostPerToken
  )
}

function loadCachedPricingAndSettings(baseDir: string, uid: number): CachedRates {
  const userdataDir = join(baseDir, 'userdata')
  if (!verifiedMemberDir(userdataDir, uid)) {
    return { ratesSig: 'none', settingsSig: 'none', table: new Map(), overrides: new Map(), aliases: new Map(), defaultModel: null }
  }
  const ratesFile = join(userdataDir, 'usage-model-rates.json')
  const settingsFile = join(userdataDir, 'settings.json')
  const rStat = verifiedMemberFile(ratesFile, uid)
  const sStat = verifiedMemberFile(settingsFile, uid)
  const ratesSig = rStat ? `${rStat.mtimeMs}:${rStat.size}` : 'none'
  const settingsSig = sStat ? `${sStat.mtimeMs}:${sStat.size}` : 'none'

  const prev = rateCacheByBaseDir.get(baseDir)
  if (prev && prev.ratesSig === ratesSig && prev.settingsSig === settingsSig) {
    return prev
  }

  let table = prev && prev.ratesSig === ratesSig ? prev.table : new Map<string, SpeedRates>()
  if ((!prev || prev.ratesSig !== ratesSig) && rStat) {
    try {
      const parsed = JSON.parse(readFileSync(ratesFile, 'utf8')) as { document?: unknown }
      table = parseLiteLLMRateTable(parsed?.document)
    } catch {
      table = new Map()
    }
  }

  const overrides = new Map<string, SpeedRates>()
  const aliases = new Map<string, string>()
  let defaultModel: string | null = null
  if (sStat) {
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        usagePriceOverrides?: Record<string, {
          inputCostPerMillionTokens?: number
          outputCostPerMillionTokens?: number
          cacheReadCostPerMillionTokens?: number
          cacheWriteCostPerMillionTokens?: number
        }>
        textGenerationModelAliases?: Record<string, string>
        defaultModelSelection?: { instanceId?: unknown; model?: unknown }
      }
      if (settings.usagePriceOverrides && typeof settings.usagePriceOverrides === 'object') {
        for (const [k, p] of Object.entries(settings.usagePriceOverrides)) {
          const inp = finiteNumber(p?.inputCostPerMillionTokens)
          const out = finiteNumber(p?.outputCostPerMillionTokens)
          if (inp === null || out === null) continue
          const cr = finiteNumber(p?.cacheReadCostPerMillionTokens) ?? inp
          const cw = finiteNumber(p?.cacheWriteCostPerMillionTokens) ?? inp
          overrides.set(k.trim(), {
            inputCostPerToken: inp / 1e6,
            outputCostPerToken: out / 1e6,
            cacheReadCostPerToken: cr / 1e6,
            cacheCreationCostPerToken: cw / 1e6,
            fast: null,
            ultrafast: null,
            contextTiers: [],
          })
        }
      }
      if (settings.textGenerationModelAliases && typeof settings.textGenerationModelAliases === 'object') {
        for (const [from, to] of Object.entries(settings.textGenerationModelAliases)) {
          if (typeof to === 'string' && to.trim()) aliases.set(from.trim(), to.trim())
        }
      }
      const def = settings.defaultModelSelection
      if (def && typeof def === 'object') {
        const inst = typeof def.instanceId === 'string' && def.instanceId.trim() ? def.instanceId.trim() : null
        const mod = typeof def.model === 'string' && def.model.trim() ? def.model.trim() : null
        if (inst && mod) defaultModel = `${inst}/${mod}`
        else if (mod) defaultModel = mod
      }
    } catch {
      // ignore malformed settings.json
    }
  }

  const next: CachedRates = { ratesSig, settingsSig, table, overrides, aliases, defaultModel }
  rateCacheByBaseDir.set(baseDir, next)
  return next
}

export function readT3DefaultModel(explicitBaseDir?: string): string | null {
  try {
    const { baseDir, uid } = resolveVerifiedBaseDir(explicitBaseDir)
    return loadCachedPricingAndSettings(baseDir, uid).defaultModel
  } catch {
    return null
  }
}

function codexSpeedFromOptions(options: unknown): 'standard' | 'fast' | 'ultrafast' {
  if (!Array.isArray(options)) return 'standard'
  for (const opt of options) {
    if (!opt || typeof opt !== 'object') continue
    const o = opt as { id?: unknown; value?: unknown }
    if (o.id === 'serviceTier' || o.id === 'speed') {
      if (o.value === 'priority' || o.value === 'fast') return 'fast'
      if (o.value === 'ultrafast') return 'ultrafast'
    }
  }
  return 'standard'
}

export function readT3ThreadUsage(threadId: string, opts: { baseDir?: string } = {}): T3ThreadUsageSnapshot {
  if (!threadId || typeof threadId !== 'string') {
    return { usage: zeroThreadUsage(), byRunId: {}, context: null, activeModel: null }
  }
  let baseDir: string
  let uid: number
  try {
    ({ baseDir, uid } = resolveVerifiedBaseDir(opts.baseDir))
  } catch {
    return { usage: zeroThreadUsage(), byRunId: {}, context: null, activeModel: null }
  }

  const userdataDir = join(baseDir, 'userdata')
  if (!verifiedMemberDir(userdataDir, uid)) {
    return { usage: zeroThreadUsage(), byRunId: {}, context: null, activeModel: null }
  }
  const dbPath = join(userdataDir, 'statev2.sqlite')
  if (!verifiedMemberFile(dbPath, uid)) {
    return { usage: zeroThreadUsage(), byRunId: {}, context: null, activeModel: null }
  }

  const pricing = loadCachedPricingAndSettings(baseDir, uid)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 150; PRAGMA query_only = ON;')

    let activeModel: string | null = null
    let context: { usedTokens: number; maxTokens: number } | null = null

    try {
      const thRow = db.prepare(
        `SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ? LIMIT 1`,
      ).get(threadId) as { payload_json?: string } | undefined
      if (thRow?.payload_json) {
        const th = JSON.parse(thRow.payload_json) as {
          providerInstanceId?: unknown
          modelSelection?: { instanceId?: unknown; model?: unknown }
          activeProviderThreadId?: unknown
        }
        const inst = typeof th.modelSelection?.instanceId === 'string'
          ? th.modelSelection.instanceId
          : (typeof th.providerInstanceId === 'string' ? th.providerInstanceId : null)
        const mod = typeof th.modelSelection?.model === 'string' ? th.modelSelection.model : null
        if (inst && mod) activeModel = `${inst}/${mod}`
        if (typeof th.activeProviderThreadId === 'string') {
          const pthRow = db.prepare(
            `SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ? LIMIT 1`,
          ).get(th.activeProviderThreadId) as { payload_json?: string } | undefined
          if (pthRow?.payload_json) {
            const pth = JSON.parse(pthRow.payload_json) as { contextUsage?: { usedTokens?: unknown; maxTokens?: unknown } }
            const used = finiteNumber(pth.contextUsage?.usedTokens)
            const max = finiteNumber(pth.contextUsage?.maxTokens)
            if (used !== null && max !== null && max > 0) context = { usedTokens: used, maxTokens: max }
          }
        }
      }
    } catch {
      // Older or minimal T3 statev2 schemas may omit optional tables; continue gracefully.
    }

    const rows = db.prepare(`
      SELECT
        pt.status AS status,
        pt.payload_json AS turn_json,
        pth.driver AS driver,
        pth.provider_instance_id AS instance_id,
        ra.run_id AS run_id,
        r.payload_json AS run_json
      FROM orchestration_v2_projection_provider_turns pt
      LEFT JOIN orchestration_v2_projection_provider_threads pth
        ON pth.provider_thread_id = pt.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts ra
        ON ra.attempt_id = pt.run_attempt_id
      LEFT JOIN orchestration_v2_projection_runs r
        ON r.run_id = ra.run_id
      WHERE pt.thread_id = ?
      ORDER BY pt.rowid ASC
    `).all(threadId) as {
      status: string
      turn_json: string
      driver: string | null
      instance_id: string | null
      run_id: string | null
      run_json: string | null
    }[]

    const total = zeroThreadUsage()
    const byRunId: Record<string, T3ThreadTurnUsage> = {}

    for (const row of rows) {
      let pt: {
        model?: unknown
        turnTokenUsage?: {
          inputTokens?: unknown
          outputTokens?: unknown
          cachedInputTokens?: unknown
          cacheCreationTokens?: unknown
          models?: unknown
        } | null
        tokenUsage?: {
          usedTokens?: unknown
          maxTokens?: unknown
          inputTokens?: unknown
          outputTokens?: unknown
          reasoningOutputTokens?: unknown
          cachedInputTokens?: unknown
        } | null
      }
      try {
        pt = JSON.parse(row.turn_json)
      } catch {
        continue
      }

      const tu = pt.tokenUsage
      if (tu) {
        const used = finiteNumber(tu.usedTokens)
        const max = finiteNumber(tu.maxTokens)
        if (used !== null && max !== null && max > 0) {
          context = { usedTokens: used, maxTokens: max }
        }
      }

      const ttu = pt.turnTokenUsage
      let rawInput = 0
      let cachedRead = 0
      let cacheWrite = 0
      let output = 0
      let hasTokenRecord = false

      if (ttu && typeof ttu === 'object') {
        const inp = finiteNumber(ttu.inputTokens)
        const out = finiteNumber(ttu.outputTokens)
        const cr = finiteNumber(ttu.cachedInputTokens) ?? 0
        const cw = finiteNumber(ttu.cacheCreationTokens) ?? 0
        if (inp !== null || out !== null || cr > 0 || cw > 0) {
          rawInput = Math.max(0, inp ?? (cr + cw))
          cachedRead = Math.max(0, cr)
          cacheWrite = Math.max(0, cw)
          output = Math.max(0, out ?? 0)
          hasTokenRecord = rawInput > 0 || output > 0 || row.status === 'completed'
        }
      } else if (tu && typeof tu === 'object') {
        const inp = finiteNumber(tu.inputTokens)
        const out = finiteNumber(tu.outputTokens)
        const reas = finiteNumber(tu.reasoningOutputTokens) ?? 0
        const cr = finiteNumber(tu.cachedInputTokens) ?? 0
        if (inp !== null || out !== null || cr > 0) {
          rawInput = Math.max(0, inp ?? cr)
          cachedRead = Math.max(0, cr)
          output = Math.max(0, (out ?? 0) + reas)
          hasTokenRecord = rawInput > 0 || output > 0 || row.status === 'completed'
        }
      }

      if (!hasTokenRecord) continue

      const uncachedInput = Math.max(0, rawInput - cachedRead - cacheWrite)
      let runSel: { instanceId?: unknown; model?: unknown; options?: unknown } | undefined
      if (row.run_json) {
        try {
          const parsedRun = JSON.parse(row.run_json) as { modelSelection?: { instanceId?: unknown; model?: unknown; options?: unknown } }
          runSel = parsedRun.modelSelection
        } catch {
          runSel = undefined
        }
      }

      const driver = (
        row.driver
        || (typeof runSel?.instanceId === 'string' ? runSel.instanceId : null)
        || row.instance_id
        || (activeModel?.includes('/') ? activeModel.slice(0, activeModel.indexOf('/')) : null)
        || 'other'
      )

      const ttuModels = Array.isArray(ttu?.models) ? ttu!.models.filter((m): m is string => typeof m === 'string' && !!m.trim()) : []
      const turnModel = (
        (typeof pt.model === 'string' && pt.model.trim() ? pt.model.trim() : null)
        ?? ttuModels[0]
        ?? (typeof runSel?.model === 'string' && runSel.model.trim() ? runSel.model.trim() : null)
        ?? (activeModel?.includes('/') ? activeModel.slice(activeModel.indexOf('/') + 1) : activeModel)
      )

      const turnContextTokens = finiteNumber(tu?.usedTokens) ?? context?.usedTokens ?? 0
      const turnCost = priceTurnTokens({
        driver,
        model: turnModel,
        speed: driver === 'codex' ? codexSpeedFromOptions(runSel?.options) : 'standard',
        contextTokens: turnContextTokens,
        uncachedInputTokens: uncachedInput,
        cachedInputTokens: cachedRead,
        cacheCreationTokens: cacheWrite,
        outputTokens: output,
        table: pricing.table,
        overrides: pricing.overrides,
        aliases: pricing.aliases,
      })

      total.inputTokens += uncachedInput
      total.cacheReadTokens += cachedRead
      total.cacheWriteTokens += cacheWrite
      total.outputTokens += output
      total.cost += turnCost
      total.turns += 1

      if (row.run_id) {
        const entry = byRunId[row.run_id] ?? zeroThreadUsage()
        entry.inputTokens += uncachedInput
        entry.cacheReadTokens += cachedRead
        entry.cacheWriteTokens += cacheWrite
        entry.outputTokens += output
        entry.cost += turnCost
        entry.turns += 1
        byRunId[row.run_id] = entry
      }
    }

    return { usage: total, byRunId, context, activeModel }
  } catch {
    return { usage: zeroThreadUsage(), byRunId: {}, context: null, activeModel: null }
  } finally {
    db.close()
  }
}
