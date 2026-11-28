export type T3UsageMetric = 'limits' | 'tokens' | 'price'
export type T3UsagePeriod = 'day' | 'week' | 'month' | 'quarter'

export type T3UsageSearch = {
  tab?: T3UsageMetric
  period?: T3UsagePeriod
}

export function validateT3UsageSearch(s: Record<string, unknown>): T3UsageSearch {
  const tab = s.tab === 'limits' || s.tab === 'tokens' || s.tab === 'price' ? s.tab : undefined
  const period = s.period === 'day' || s.period === 'week' || s.period === 'month' || s.period === 'quarter' ? s.period : undefined
  return { ...(tab ? { tab } : {}), ...(period ? { period } : {}) }
}

export type T3PriceOverride = {
  inputCostPerMillionTokens: number
  outputCostPerMillionTokens: number
  cacheReadCostPerMillionTokens?: number
  cacheWriteCostPerMillionTokens?: number
}

export type T3LimitWindowShape = {
  id: string
  kind: 'session' | 'weekly' | 'monthly' | 'other'
  label: string
  group?: string | null
  groupDetail?: string | null
  usedPercent: number
  remainingPercent: number
  resetsAt: string | null
  windowDurationMins: number | null
}

export type T3LimitWindowGroup<W extends T3LimitWindowShape = T3LimitWindowShape> = {
  key: string
  group: string | null
  groupDetail: string | null
  windows: W[]
}

export function groupLimitWindows<W extends T3LimitWindowShape>(windows: W[]): T3LimitWindowGroup<W>[] {
  const groups: T3LimitWindowGroup<W>[] = []
  for (const w of windows) {
    const g = typeof w.group === 'string' && w.group.trim() ? w.group.trim() : null
    const detail = typeof w.groupDetail === 'string' && w.groupDetail.trim() ? w.groupDetail.trim() : null
    const prev = groups.at(-1)
    if (prev && prev.group === g) {
      if (!prev.groupDetail && detail) prev.groupDetail = detail
      prev.windows.push(w)
    } else {
      groups.push({
        key: `${g ?? 'default'}:${groups.length}`,
        group: g,
        groupDetail: detail,
        windows: [w],
      })
    }
  }
  return groups
}

export type T3UsageBucketShape = {
  day: string
  hourStart?: string
  provider: string
  model: string
  sourcePath?: string
  totals: {
    uncachedInputTokens: number
    cachedInputTokens: number
    cacheCreationTokens: number
    outputTokens: number
    reasoningTokens: number
  }
  costUsd: number
  cacheSavingsUsd: number
  categoryCostUsd?: {
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
  }
  fastCostUsd?: number
  ultrafastCostUsd?: number
  speedPremiumUsd?: number
  costSource: 'providerReported' | 'modelPriced' | 'unpriced'
  records: number
  unpricedRecords: number
  unpricedTokens?: number
  sessions: number
}

export type T3UsageSourceShape = {
  fingerprint: {
    hostId: string
    provider: string
    resolvedHomePath: string
    volumeId: string
    physicalSourceId?: string
  }
  status: 'ok' | 'missing' | 'partial' | 'failed'
  scannedFiles: number
  skippedFiles: number
  malformedRecords: number
  distinctSessions: number
  message: string | null
  refreshing?: boolean
}

export type T3SummaryShape = {
  connected: boolean
  period: T3UsagePeriod
  resolution: 'hour' | 'day'
  timeZone: string
  sinceDay: string
  untilDay: string
  sinceTime?: string
  untilTime?: string
  readAt: string
  scanDurationMs: number
  buckets: T3UsageBucketShape[]
  sources: T3UsageSourceShape[]
  pricing: {
    status: 'fresh' | 'cached' | 'unavailable'
    source: string
    fetchedAt: string | null
    knownModels: number
  }
  priceOverrides: Record<string, T3PriceOverride>
  modelAliases: Record<string, string>
  error?: string
}

export const PROVIDER_META: Record<string, { label: string; color: string }> = {
  antigravity: { label: 'Antigravity', color: '#3b82f6' },
  codex: { label: 'Codex', color: '#10b981' },
  claude: { label: 'Claude', color: '#d97757' },
  claudeAgent: { label: 'Claude', color: '#d97757' },
  opencode: { label: 'OpenCode', color: '#8b5cf6' },
  cursor: { label: 'Cursor', color: '#06b6d4' },
  grok: { label: 'Grok', color: '#f59e0b' },
  pi: { label: 'Pi', color: '#ec4899' },
  muse: { label: 'Muse Code', color: '#14b8a6' },
}

export function providerLabel(driver: string): string {
  return PROVIDER_META[driver]?.label ?? driver.charAt(0).toUpperCase() + driver.slice(1)
}

export function providerColor(driver: string, override?: string | null): string {
  if (override && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(override.trim())) return override.trim()
  return PROVIDER_META[driver]?.color ?? '#6366f1'
}

const currencyFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const currencyPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 4 })
const integerFmt = new Intl.NumberFormat('en-US')

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.01) return n < 0.0005 ? '<$0.001' : currencyPrecise.format(n)
  return currencyFull.format(n)
}

export function formatCompactTokens(n: number): string {
  const v = Math.round(n)
  if (Math.abs(v) < 1000) return integerFmt.format(v)
  const units = ['K', 'M', 'B', 'T']
  let val = n / 1000
  let idx = 0
  const fmtUnit = (x: number) => {
    const abs = Math.abs(x)
    const dec = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
    return x.toFixed(dec).replace(/\.0+$/, '')
  }
  while (Math.abs(Number(fmtUnit(val))) >= 1000 && idx < units.length - 1) {
    val /= 1000
    idx++
  }
  return `${fmtUnit(val)}${units[idx]}`
}

export function formatInt(n: number): string {
  return integerFmt.format(Math.round(n))
}

export function formatShare(share: number, decimals = 1): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const pct = share * 100
  const min = 10 ** -decimals
  if (pct < min) return `<${min.toFixed(decimals)}%`
  return `${pct.toFixed(decimals).replace(/\.0$/, '')}%`
}

export function formatResetCountdown(iso: string | null, nowMs = Date.now()): string | null {
  if (!iso) return null
  const target = Date.parse(iso)
  if (!Number.isFinite(target)) return null
  const diff = target - nowMs
  if (diff <= 0) return 'Resets now'
  if (diff < 60_000) return 'Resets momentarily'
  const mins = Math.floor(diff / 60_000)
  const days = Math.floor(mins / (24 * 60))
  const hours = Math.floor((mins % (24 * 60)) / 60)
  const remMins = mins % 60
  if (days > 0) return `Resets in ${days}d ${hours}h`
  if (hours > 0) return `Resets in ${hours}h ${remMins}m`
  return `Resets in ${remMins}m`
}

export type WindowPace = {
  /** Percent of window duration remaining (0..100), where steady even spending would sit. */
  timeLeftPercent: number
  /** Positive means ahead/conserving (more quota left than time left); negative means burning faster than window reset. */
  deltaPercent: number
  state: 'ahead' | 'even' | 'fast'
}

export function computeWindowPace(w: T3LimitWindowShape, nowMs = Date.now()): WindowPace | null {
  if (!w.resetsAt || !w.windowDurationMins || w.windowDurationMins <= 0) return null
  const resetMs = Date.parse(w.resetsAt)
  if (!Number.isFinite(resetMs)) return null
  const durationMs = w.windowDurationMins * 60_000
  const remainingMs = resetMs - nowMs
  if (remainingMs <= 0 || remainingMs > durationMs) return null
  const timeLeftPercent = Math.max(0, Math.min(100, (remainingMs / durationMs) * 100))
  const deltaPercent = w.remainingPercent - timeLeftPercent
  const state = deltaPercent >= 5 ? 'ahead' : deltaPercent <= -5 ? 'fast' : 'even'
  return { timeLeftPercent, deltaPercent, state }
}

export type AggregatedModelRow = {
  key: string
  model: string
  provider: string
  costUsd: number
  totalTokens: number
  tokens: {
    uncachedInputTokens: number
    cachedInputTokens: number
    cacheCreationTokens: number
    outputTokens: number
    reasoningTokens: number
  }
  records: number
  unpricedRecords: number
  unpricedTokens: number
  costShare: number
  tokenShare: number
  isUnpriced: boolean
  hasOverride: boolean
  alias: string | null
}

export type AggregatedProviderRow = {
  provider: string
  costUsd: number
  totalTokens: number
  records: number
  sessions: number
  costShare: number
  tokenShare: number
}

export type TimelinePoint = {
  key: string
  label: string
  fullLabel: string
  costUsd: number
  totalTokens: number
  byProvider: Record<string, { costUsd: number; totalTokens: number }>
}

function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const out: string[] = []
  const start = Date.parse(`${sinceDay}T00:00:00Z`)
  const end = Date.parse(`${untilDay}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out
  for (let ms = start; ms <= end; ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

function enumerateHours(sinceTime?: string, untilTime?: string): string[] {
  if (!sinceTime || !untilTime) return []
  const start = Date.parse(sinceTime)
  const end = Date.parse(untilTime)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
  const alignedStart = Math.floor(start / 3_600_000) * 3_600_000
  const out: string[] = []
  for (let ms = alignedStart; ms <= end; ms += 3_600_000) {
    out.push(new Date(ms).toISOString())
  }
  return out
}

function shortDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[m - 1] ?? ''} ${d}`
}

function shortHourLabel(iso: string, timeZone: string): { short: string; full: string } {
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return { short: iso, full: iso }
  try {
    const short = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: true }).format(dt)
    const full = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(dt)
    return { short, full }
  } catch {
    return { short: iso.slice(11, 16), full: iso }
  }
}

export function aggregateT3Usage(data: T3SummaryShape | undefined, hiddenProviders: ReadonlySet<string> = new Set()) {
  if (!data) {
    return {
      allProviders: [] as string[],
      costUsd: 0,
      cacheSavingsUsd: 0,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cacheHitRate: 0,
      records: 0,
      sessions: 0,
      providers: [] as AggregatedProviderRow[],
      models: [] as AggregatedModelRow[],
      series: [] as TimelinePoint[],
      costQuality: { providerReportedShare: 0, modelPricedShare: 0, unpricedShare: 0, unpricedTokens: 0 },
      categoryCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 },
      speedCost: { standard: 0, fast: 0, ultrafast: 0, premium: 0 },
      warnings: [] as string[],
    }
  }

  const providerSet = new Set<string>()
  for (const s of data.sources) if (s.status !== 'missing') providerSet.add(s.fingerprint.provider)
  for (const b of data.buckets) providerSet.add(b.provider)
  const allProviders = [...providerSet].sort()

  // Deduplicate scanned sources by physicalSourceId or [hostId, provider, resolvedHomePath, volumeId].
  const seenSources = new Set<string>()
  const activeSourceKeys = new Set<string>()
  const activeProviders = new Set<string>()
  const sessionsByProvider = new Map<string, number>()
  const warnings = new Set<string>()

  for (const src of data.sources) {
    if (src.status === 'partial' || src.status === 'failed') {
      if (src.message) warnings.add(`${providerLabel(src.fingerprint.provider)}: ${src.message}`)
    }
    if (src.malformedRecords > 0) {
      warnings.add(`${src.malformedRecords} malformed usage record(s) skipped in ${providerLabel(src.fingerprint.provider)}.`)
    }
    if (src.status === 'missing') continue
    const p = src.fingerprint.provider
    if (hiddenProviders.has(p)) continue
    const fpKey = src.fingerprint.physicalSourceId
      ? `${p}\0${src.fingerprint.physicalSourceId}`
      : `${src.fingerprint.hostId}\0${p}\0${src.fingerprint.resolvedHomePath}\0${src.fingerprint.volumeId}`
    if (seenSources.has(fpKey)) continue
    seenSources.add(fpKey)
    activeProviders.add(p)
    activeSourceKeys.add(`${p}\0${src.fingerprint.resolvedHomePath}`)
    sessionsByProvider.set(p, (sessionsByProvider.get(p) ?? 0) + src.distinctSessions)
  }

  let costUsd = 0
  let cacheSavingsUsd = 0
  let uncachedInputTokens = 0
  let cachedInputTokens = 0
  let cacheCreationTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let records = 0
  let providerReportedRecords = 0
  let unpricedRecords = 0
  let unpricedTokensTotal = 0

  const cat = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const spd = { fast: 0, ultrafast: 0, premium: 0 }
  const provMap = new Map<string, { costUsd: number; totalTokens: number; records: number; sessions: number }>()
  for (const [p, sess] of sessionsByProvider) {
    if (sess > 0) provMap.set(p, { costUsd: 0, totalTokens: 0, records: 0, sessions: sess })
  }

  const modelMap = new Map<string, {
    model: string
    provider: string
    costUsd: number
    totalTokens: number
    tokens: {
      uncachedInputTokens: number
      cachedInputTokens: number
      cacheCreationTokens: number
      outputTokens: number
      reasoningTokens: number
    }
    records: number
    unpricedRecords: number
    unpricedTokens: number
  }>()

  const bucketPoints = new Map<string, { costUsd: number; totalTokens: number; byProvider: Record<string, { costUsd: number; totalTokens: number }> }>()

  for (const b of data.buckets) {
    if (hiddenProviders.has(b.provider)) continue
    if (b.sourcePath ? (activeSourceKeys.size > 0 && !activeSourceKeys.has(`${b.provider}\0${b.sourcePath}`)) : (activeProviders.size > 0 && !activeProviders.has(b.provider))) {
      // Allow buckets even when a provider has no source entry reported.
      if (data.sources.some((s) => s.fingerprint.provider === b.provider && s.status !== 'missing')) continue
    }
    const tok = b.totals.uncachedInputTokens + b.totals.cachedInputTokens + b.totals.cacheCreationTokens + b.totals.outputTokens
    costUsd += b.costUsd
    cacheSavingsUsd += b.cacheSavingsUsd
    uncachedInputTokens += b.totals.uncachedInputTokens
    cachedInputTokens += b.totals.cachedInputTokens
    cacheCreationTokens += b.totals.cacheCreationTokens
    outputTokens += b.totals.outputTokens
    reasoningTokens += b.totals.reasoningTokens
    records += b.records
    unpricedRecords += b.unpricedRecords
    if (b.costSource === 'providerReported') providerReportedRecords += b.records
    const bucketUnpricedTokens = b.unpricedTokens !== undefined
      ? b.unpricedTokens
      : b.records > 0 ? (tok * b.unpricedRecords) / b.records : 0
    unpricedTokensTotal += bucketUnpricedTokens

    if (b.categoryCostUsd) {
      cat.input += b.categoryCostUsd.input
      cat.cacheRead += b.categoryCostUsd.cacheRead
      cat.cacheWrite += b.categoryCostUsd.cacheWrite
      cat.output += b.categoryCostUsd.output
    }
    spd.fast += b.fastCostUsd ?? 0
    spd.ultrafast += b.ultrafastCostUsd ?? 0
    spd.premium += b.speedPremiumUsd ?? 0

    const pEntry = provMap.get(b.provider) ?? { costUsd: 0, totalTokens: 0, records: 0, sessions: 0 }
    pEntry.costUsd += b.costUsd
    pEntry.totalTokens += tok
    pEntry.records += b.records
    provMap.set(b.provider, pEntry)

    const mKey = `${b.provider}:${b.model}`
    const mEntry = modelMap.get(mKey) ?? {
      model: b.model,
      provider: b.provider,
      costUsd: 0,
      totalTokens: 0,
      tokens: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      records: 0,
      unpricedRecords: 0,
      unpricedTokens: 0,
    }
    mEntry.costUsd += b.costUsd
    mEntry.totalTokens += tok
    mEntry.tokens.uncachedInputTokens += b.totals.uncachedInputTokens
    mEntry.tokens.cachedInputTokens += b.totals.cachedInputTokens
    mEntry.tokens.cacheCreationTokens += b.totals.cacheCreationTokens
    mEntry.tokens.outputTokens += b.totals.outputTokens
    mEntry.tokens.reasoningTokens += b.totals.reasoningTokens
    mEntry.records += b.records
    mEntry.unpricedRecords += b.unpricedRecords
    mEntry.unpricedTokens += bucketUnpricedTokens
    modelMap.set(mKey, mEntry)

    const tKey = data.resolution === 'hour' && b.hourStart ? b.hourStart : b.day
    const pt = bucketPoints.get(tKey) ?? { costUsd: 0, totalTokens: 0, byProvider: {} }
    pt.costUsd += b.costUsd
    pt.totalTokens += tok
    const pb = pt.byProvider[b.provider] ?? { costUsd: 0, totalTokens: 0 }
    pb.costUsd += b.costUsd
    pb.totalTokens += tok
    pt.byProvider[b.provider] = pb
    bucketPoints.set(tKey, pt)
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens
  const totalInput = uncachedInputTokens + cachedInputTokens + cacheCreationTokens
  const cacheHitRate = totalInput > 0 ? cachedInputTokens / totalInput : 0
  let totalSessions = 0
  for (const v of provMap.values()) totalSessions += v.sessions

  const providers: AggregatedProviderRow[] = [...provMap.entries()]
    .map(([provider, v]) => ({
      provider,
      costUsd: v.costUsd,
      totalTokens: v.totalTokens,
      records: v.records,
      sessions: v.sessions,
      costShare: costUsd > 0 ? v.costUsd / costUsd : 0,
      tokenShare: totalTokens > 0 ? v.totalTokens / totalTokens : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)

  const models: AggregatedModelRow[] = [...modelMap.entries()]
    .map(([key, m]) => ({
      key,
      ...m,
      costShare: costUsd > 0 ? m.costUsd / costUsd : 0,
      tokenShare: totalTokens > 0 ? m.totalTokens / totalTokens : 0,
      isUnpriced: m.records > 0 && m.unpricedRecords >= m.records,
      hasOverride: Boolean(data.priceOverrides[m.model] || data.priceOverrides[key]),
      alias: data.modelAliases[m.model] ?? data.modelAliases[key] ?? null,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)

  const series: TimelinePoint[] = []
  if (data.resolution === 'hour') {
    const hours = enumerateHours(data.sinceTime, data.untilTime)
    const keys = hours.length ? hours : [...bucketPoints.keys()].sort()
    for (const k of keys) {
      const pt = bucketPoints.get(k)
      const lbl = shortHourLabel(k, data.timeZone)
      series.push({
        key: k,
        label: lbl.short,
        fullLabel: lbl.full,
        costUsd: pt?.costUsd ?? 0,
        totalTokens: pt?.totalTokens ?? 0,
        byProvider: pt?.byProvider ?? {},
      })
    }
  } else {
    const days = enumerateDays(data.sinceDay, data.untilDay)
    const keys = days.length ? days : [...bucketPoints.keys()].sort()
    for (const k of keys) {
      const pt = bucketPoints.get(k)
      series.push({
        key: k,
        label: shortDayLabel(k),
        fullLabel: shortDayLabel(k),
        costUsd: pt?.costUsd ?? 0,
        totalTokens: pt?.totalTokens ?? 0,
        byProvider: pt?.byProvider ?? {},
      })
    }
  }

  return {
    allProviders,
    costUsd,
    cacheSavingsUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    cacheHitRate,
    records,
    sessions: totalSessions,
    providers,
    models,
    series,
    costQuality: {
      providerReportedShare: records > 0 ? providerReportedRecords / records : 0,
      unpricedShare: records > 0 ? unpricedRecords / records : 0,
      modelPricedShare: records > 0 ? Math.max(0, records - providerReportedRecords - unpricedRecords) / records : 0,
      unpricedTokens: Math.round(unpricedTokensTotal),
    },
    categoryCost: {
      ...cat,
      unsplit: Math.max(0, costUsd - cat.input - cat.cacheRead - cat.cacheWrite - cat.output),
    },
    speedCost: {
      ...spd,
      standard: Math.max(0, costUsd - spd.fast - spd.ultrafast),
    },
    warnings: [...warnings],
  }
}
