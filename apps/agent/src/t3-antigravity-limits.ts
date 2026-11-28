import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertRegularMemberUid } from './t3-local.ts'
import type { T3LimitWindow } from './t3-usage.ts'

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const AICODE_ORIGIN = 'https://aicode.googleapis.com'
const DAILY_CLOUDCODE_ORIGIN = 'https://daily-cloudcode-pa.googleapis.com'
const CLOUDCODE_ORIGIN = 'https://cloudcode-pa.googleapis.com'

const LIMITS_FRESH_MS = 30_000
const LIMITS_MAX_STALE_MS = 15 * 60_000
const PLAN_FRESH_MS = 10 * 60_000
const TOKEN_SAFETY_MARGIN_MS = 60_000

export type AntigravityLimitsSnapshot = {
  checkedAt: string
  windows: T3LimitWindow[]
  plan: string | null
  email: string | null
  externalUsage: { label: string; url: string } | null
  unavailable: { reason: 'unsupported' | 'probeFailed'; message: string | null } | null
}

type StoredAntigravityCreds = {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken: string | null
  expiryMs: number
  email: string | null
  projectId: string | null
  fingerprint: string
}

type CachedToken = {
  fingerprint: string
  accessToken: string
  expiresAtMs: number
}

type CachedPlan = {
  fingerprint: string
  fetchedAtMs: number
  plan: string | null
  externalUsage: { label: string; url: string } | null
}

type CachedLimits = {
  fingerprint: string
  fetchedAtMs: number
  snapshot: AntigravityLimitsSnapshot
}

const tokenCache = new Map<string, CachedToken>()
const planCache = new Map<string, CachedPlan>()
const limitsCache = new Map<string, CachedLimits>()
const inFlightProbes = new Map<string, Promise<AntigravityLimitsSnapshot | null>>()

export function clearAntigravityLimitsCache(): void {
  tokenCache.clear()
  planCache.clear()
  limitsCache.clear()
  inFlightProbes.clear()
}

function assertOwnedPath(target: string, uid: number, kind: 'dir' | 'file'): boolean {
  try {
    const st = lstatSync(target)
    if (st.isSymbolicLink() || st.uid !== uid) return false
    return kind === 'dir' ? st.isDirectory() : st.isFile()
  } catch {
    return false
  }
}

export function readAntigravityCredentials(baseDir: string, instanceId: string, explicitUid?: number): StoredAntigravityCreds | null {
  const uid = assertRegularMemberUid(explicitUid ?? process.getuid?.())
  const root = resolve(baseDir)
  const key = createHash('sha256').update(instanceId).digest('hex')

  const segments = ['userdata', 'providers', 'antigravity', key, 'antigravity-acp']
  let cursor = root
  if (!assertOwnedPath(cursor, uid, 'dir')) return null
  for (const seg of segments) {
    cursor = join(cursor, seg)
    if (!assertOwnedPath(cursor, uid, 'dir')) return null
  }

  const acpTokenPath = join(cursor, 'acp_token.json')
  if (!assertOwnedPath(acpTokenPath, uid, 'file')) return null

  let acpRaw: Record<string, unknown>
  try {
    acpRaw = JSON.parse(readFileSync(acpTokenPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }

  const clientId = typeof acpRaw.client_id === 'string' ? acpRaw.client_id.trim() : ''
  const clientSecret = typeof acpRaw.client_secret === 'string' ? acpRaw.client_secret.trim() : ''
  const rawTokenUri = typeof acpRaw.token_uri === 'string' && acpRaw.token_uri.trim()
    ? acpRaw.token_uri.trim()
    : GOOGLE_TOKEN_URI

  // Never send refresh tokens anywhere other than Google's official OAuth token endpoint.
  if (rawTokenUri !== GOOGLE_TOKEN_URI) return null

  let oauthRaw: Record<string, unknown> | null = null
  const oauthPath = join(cursor, 'antigravity-oauth-token')
  if (assertOwnedPath(oauthPath, uid, 'file')) {
    try {
      oauthRaw = JSON.parse(readFileSync(oauthPath, 'utf8')) as Record<string, unknown>
    } catch {
      oauthRaw = null
    }
  }

  const tokenObj = (oauthRaw?.token && typeof oauthRaw.token === 'object' ? oauthRaw.token : {}) as Record<string, unknown>
  const refreshToken = (
    (typeof tokenObj.refresh_token === 'string' && tokenObj.refresh_token.trim())
    || (typeof acpRaw.refresh_token === 'string' && acpRaw.refresh_token.trim())
    || ''
  )
  const accessToken = typeof tokenObj.access_token === 'string' && tokenObj.access_token.trim()
    ? tokenObj.access_token.trim()
    : null
  const expiryMs = typeof tokenObj.expiry === 'string' ? Date.parse(tokenObj.expiry) : Number.NaN
  const email = typeof oauthRaw?.id_token_email === 'string' && oauthRaw.id_token_email.trim()
    ? oauthRaw.id_token_email.trim()
    : null
  const projectId = typeof acpRaw.project_id === 'string' && acpRaw.project_id.trim()
    ? acpRaw.project_id.trim()
    : null

  if (!clientId || !clientSecret || !refreshToken) return null

  const fingerprint = createHash('sha256')
    .update(`${clientId}:${refreshToken}:${email ?? ''}`)
    .digest('hex')
    .slice(0, 24)

  return {
    clientId,
    clientSecret,
    refreshToken,
    accessToken,
    expiryMs: Number.isFinite(expiryMs) ? expiryMs : 0,
    email,
    projectId,
    fingerprint,
  }
}

async function resolveAccessToken(
  cacheKey: string,
  creds: StoredAntigravityCreds,
  forceRefresh: boolean,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<string> {
  if (!forceRefresh) {
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.fingerprint === creds.fingerprint && cached.expiresAtMs - nowMs > TOKEN_SAFETY_MARGIN_MS) {
      return cached.accessToken
    }
    if (creds.accessToken && creds.expiryMs - nowMs > TOKEN_SAFETY_MARGIN_MS) {
      tokenCache.set(cacheKey, {
        fingerprint: creds.fingerprint,
        accessToken: creds.accessToken,
        expiresAtMs: creds.expiryMs,
      })
      return creds.accessToken
    }
  }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  })

  const res = await fetchImpl(GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) {
    throw new Error(`Google OAuth token refresh failed (HTTP ${res.status}).`)
  }
  const json = await res.json() as { access_token?: unknown; expires_in?: unknown }
  const accessToken = typeof json.access_token === 'string' ? json.access_token.trim() : ''
  if (!accessToken) {
    throw new Error('Google OAuth token refresh returned no access token.')
  }
  const expiresInSec = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600
  tokenCache.set(cacheKey, {
    fingerprint: creds.fingerprint,
    accessToken,
    expiresAtMs: nowMs + expiresInSec * 1000,
  })
  return accessToken
}

function cleanGroupName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^gemini\s+models$/i.test(trimmed)) return 'Gemini models'
  if (/^claude\s+and\s+gpt\s+models$/i.test(trimmed)) return 'Claude & GPT models'
  return trimmed.replace(/\band\b/gi, '&')
}

function cleanGroupDetail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const stripped = raw
    .trim()
    .replace(/^models\s+within\s+this\s+group\s*:\s*/i, '')
    .trim()
  return stripped || null
}

function classifyBucketWindow(bucket: Record<string, unknown>): {
  kind: T3LimitWindow['kind']
  label: string
  windowDurationMins: number | null
  order: number
} {
  const win = typeof bucket.window === 'string' ? bucket.window.trim().toLowerCase() : ''
  const id = typeof bucket.bucketId === 'string' ? bucket.bucketId.trim().toLowerCase() : ''
  const display = typeof bucket.displayName === 'string' ? bucket.displayName.trim() : ''

  if (win === '5h' || /(?:^|-)5h$/.test(id) || /five[- ]hour|session/i.test(display)) {
    return { kind: 'session', label: 'Session', windowDurationMins: 300, order: 0 }
  }
  if (win === 'weekly' || win === '7d' || /weekly|7d|week/i.test(id) || /weekly/i.test(display)) {
    return { kind: 'weekly', label: 'Weekly', windowDurationMins: 10_080, order: 1 }
  }
  if (win === 'monthly' || win === '30d' || /monthly|30d|month/i.test(id) || /monthly/i.test(display)) {
    return { kind: 'monthly', label: 'Monthly', windowDurationMins: 43_200, order: 2 }
  }
  if (win === 'daily' || win === '24h' || win === '1d' || /daily|24h/i.test(id) || /daily|24[- ]hour/i.test(display)) {
    return { kind: 'other', label: 'Daily', windowDurationMins: 1_440, order: 3 }
  }
  const cleanLabel = display.replace(/\s+limit\s+remaining$/i, '').trim() || 'Limit'
  return { kind: 'other', label: cleanLabel, windowDurationMins: null, order: 4 }
}

/**
 * Parses AICode (`{ summary: { response: { groups } } }`) and Cloud Code PA (`{ groups }`)
 * quota summary responses into DevDash `T3LimitWindow[]`.
 */
export function parseAntigravityQuotaSummary(raw: unknown): T3LimitWindow[] {
  if (!raw || typeof raw !== 'object') return []
  const root = raw as Record<string, unknown>
  const summaryObj = (root.summary && typeof root.summary === 'object' ? root.summary : null) as Record<string, unknown> | null
  const innerResp = (summaryObj?.response && typeof summaryObj.response === 'object' ? summaryObj.response : null) as Record<string, unknown> | null
  const groupsRaw = Array.isArray(innerResp?.groups)
    ? innerResp.groups
    : Array.isArray(summaryObj?.groups)
      ? summaryObj.groups
      : Array.isArray(root.groups)
        ? root.groups
        : []

  const parsedGroups: T3LimitWindow[][] = []
  const multiGroup = groupsRaw.length > 1

  for (let gi = 0; gi < groupsRaw.length; gi += 1) {
    const g = groupsRaw[gi]
    if (!g || typeof g !== 'object') continue
    const groupObj = g as Record<string, unknown>
    const rawGroupName = typeof groupObj.displayName === 'string' ? groupObj.displayName : ''
    const groupLabel = cleanGroupName(rawGroupName)
    const groupDetail = cleanGroupDetail(groupObj.description)
    const showGroup = Boolean(groupLabel) && (multiGroup || !/^(antigravity|default|all(\s+models)?)$/i.test(groupLabel))
    const bucketsRaw = Array.isArray(groupObj.buckets) ? groupObj.buckets : []

    const entries: { order: number; win: T3LimitWindow }[] = []
    for (let bi = 0; bi < bucketsRaw.length; bi += 1) {
      const b = bucketsRaw[bi]
      if (!b || typeof b !== 'object') continue
      const bucket = b as Record<string, unknown>
      const resetsAt = typeof bucket.resetTime === 'string' && bucket.resetTime.trim() ? bucket.resetTime.trim() : null

      // Proto3 JSON omits remainingFraction when its float value is exactly 0.0 (exhausted);
      // an active resetTime with omitted remainingFraction means 0% remaining (100% used).
      let remainingFraction: number | null = null
      if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
        remainingFraction = Math.max(0, Math.min(1, bucket.remainingFraction))
      } else if (resetsAt) {
        remainingFraction = 0
      } else {
        continue
      }

      const remainingPercent = Math.round(remainingFraction * 10_000) / 100
      const usedPercent = Math.round((100 - remainingPercent) * 100) / 100
      const meta = classifyBucketWindow(bucket)
      const bucketId = typeof bucket.bucketId === 'string' && bucket.bucketId.trim()
        ? bucket.bucketId.trim()
        : `group-${gi}-${meta.kind}-${bi}`

      entries.push({
        order: meta.order,
        win: {
          id: bucketId,
          kind: meta.kind,
          label: meta.label,
          group: showGroup ? groupLabel : null,
          groupDetail: showGroup ? groupDetail : null,
          usedPercent,
          remainingPercent,
          resetsAt,
          windowDurationMins: meta.windowDurationMins,
        },
      })
    }

    entries.sort((a, b) => a.order - b.order)
    if (entries.length > 0) {
      parsedGroups.push(entries.map((e) => e.win))
    }
  }

  return parsedGroups.flat()
}

/**
 * Fallback parser for Cloud Code PA `fetchAvailableModels` if AICode `getUserQuotaSummary`
 * is unavailable or omits the Gemini model pool.
 */
export function parseCloudCodeGeminiFallback(raw: unknown): T3LimitWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const models = (raw as { models?: unknown }).models
  if (!models || typeof models !== 'object') return null

  let minFraction: number | null = null
  let chosenReset: string | null = null
  const names: string[] = []

  for (const [modelId, val] of Object.entries(models as Record<string, unknown>)) {
    if (!modelId.startsWith('gemini-') || modelId.includes('image')) continue
    if (!val || typeof val !== 'object') continue
    const m = val as Record<string, unknown>
    const qi = (m.quotaInfo && typeof m.quotaInfo === 'object' ? m.quotaInfo : null) as Record<string, unknown> | null
    if (!qi) continue
    const resetTime = typeof qi.resetTime === 'string' && qi.resetTime.trim() ? qi.resetTime.trim() : null
    const frac = typeof qi.remainingFraction === 'number' && Number.isFinite(qi.remainingFraction)
      ? Math.max(0, Math.min(1, qi.remainingFraction))
      : resetTime
        ? 0
        : null
    if (frac === null) continue
    if (typeof m.displayName === 'string' && m.displayName.trim() && !names.includes(m.displayName.trim())) {
      names.push(m.displayName.trim())
    }
    if (minFraction === null || frac < minFraction) {
      minFraction = frac
      chosenReset = resetTime
    } else if (frac === minFraction && !chosenReset && resetTime) {
      chosenReset = resetTime
    }
  }

  if (minFraction === null) return null
  const remainingPercent = Math.round(minFraction * 10_000) / 100
  const usedPercent = Math.round((100 - remainingPercent) * 100) / 100
  return {
    id: 'gemini-5h',
    kind: 'session',
    label: 'Session',
    group: 'Gemini models',
    groupDetail: names.slice(0, 5).join(', ') || null,
    usedPercent,
    remainingPercent,
    resetsAt: chosenReset,
    windowDurationMins: 300,
  }
}

function sanitizeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

export function parseAntigravityPlanInfo(licensesRaw: unknown, loadCodeAssistRaw?: unknown): {
  plan: string | null
  externalUsage: { label: string; url: string } | null
} {
  if (licensesRaw && typeof licensesRaw === 'object') {
    const licenses = (licensesRaw as { licenses?: unknown }).licenses
    if (Array.isArray(licenses) && licenses.length > 0) {
      const first = licenses[0] as Record<string, unknown>
      const tierName = typeof first?.tierDisplayName === 'string' && first.tierDisplayName.trim()
        ? first.tierDisplayName.trim()
        : null
      if (tierName) {
        return { plan: tierName, externalUsage: null }
      }
    }
  }

  if (loadCodeAssistRaw && typeof loadCodeAssistRaw === 'object') {
    const lca = loadCodeAssistRaw as Record<string, unknown>
    const paid = (lca.paidTier && typeof lca.paidTier === 'object' ? lca.paidTier : null) as Record<string, unknown> | null
    if (paid && typeof paid.name === 'string' && paid.name.trim()) {
      return { plan: paid.name.trim(), externalUsage: null }
    }
    const curr = (lca.currentTier && typeof lca.currentTier === 'object' ? lca.currentTier : null) as Record<string, unknown> | null
    if (curr && typeof curr.name === 'string' && curr.name.trim() && !/^antigravity$/i.test(curr.name.trim())) {
      const manageUrl = sanitizeExternalUrl(lca.manageSubscriptionUri)
      return {
        plan: curr.name.trim(),
        externalUsage: manageUrl ? { label: 'Subscription', url: manageUrl } : null,
      }
    }
  }

  return { plan: null, externalUsage: null }
}

export async function getAntigravityUsageLimits(opts: {
  baseDir: string
  instanceId: string
  version?: string | null
  refresh?: boolean
  uid?: number
  fetchImpl?: typeof fetch
  nowMs?: number
}): Promise<AntigravityLimitsSnapshot | null> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const nowMs = opts.nowMs ?? Date.now()
  const creds = readAntigravityCredentials(opts.baseDir, opts.instanceId, opts.uid)
  if (!creds) return null

  const cacheKey = `${resolve(opts.baseDir)}:${opts.instanceId}`
  const existing = limitsCache.get(cacheKey)
  if (
    !opts.refresh
    && existing
    && existing.fingerprint === creds.fingerprint
    && nowMs - existing.fetchedAtMs < LIMITS_FRESH_MS
  ) {
    return existing.snapshot
  }

  const inFlight = inFlightProbes.get(cacheKey)
  if (inFlight && !opts.refresh) return inFlight

  const ver = typeof opts.version === 'string' && /^[0-9][0-9A-Za-z._-]{0,31}$/.test(opts.version.trim())
    ? opts.version.trim()
    : '1.5.17'
  const userAgent = `antigravity/${ver} linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`

  const probe = (async (): Promise<AntigravityLimitsSnapshot> => {
    const checkedAt = new Date(nowMs).toISOString()
    try {
      const callAuthedJson = async (
        url: string,
        init: { method: 'GET' | 'POST'; body?: string },
      ): Promise<{ status: number; data: unknown }> => {
        const attempt = async (forceToken: boolean) => {
          const token = await resolveAccessToken(cacheKey, creds, forceToken, fetchImpl, nowMs)
          return fetchImpl(url, {
            method: init.method,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': userAgent,
            },
            ...(init.body !== undefined ? { body: init.body } : {}),
            signal: AbortSignal.timeout(8_000),
          })
        }
        let res = await attempt(false)
        if (res.status === 401) {
          tokenCache.delete(cacheKey)
          res = await attempt(true)
        }
        if (!res.ok) return { status: res.status, data: null }
        const data = await res.json().catch(() => null)
        return { status: res.status, data }
      }

      const cachedPlan = planCache.get(cacheKey)
      const needPlan = opts.refresh
        || !cachedPlan
        || cachedPlan.fingerprint !== creds.fingerprint
        || nowMs - cachedPlan.fetchedAtMs >= PLAN_FRESH_MS

      const [aicodeQuotaRes, licensesRes] = await Promise.all([
        callAuthedJson(`${AICODE_ORIGIN}/v1alpha/remote:getUserQuotaSummary`, { method: 'GET' }),
        needPlan
          ? callAuthedJson(`${AICODE_ORIGIN}/v1alpha:fetchLicenses`, { method: 'GET' })
          : Promise.resolve({ status: 200, data: null }),
      ])

      let windows = parseAntigravityQuotaSummary(aicodeQuotaRes.data)
      let lcaData: unknown = null

      if (windows.length === 0) {
        const projectPayload = creds.projectId ? JSON.stringify({ project: creds.projectId }) : '{}'
        for (const origin of [DAILY_CLOUDCODE_ORIGIN, CLOUDCODE_ORIGIN]) {
          const [ccSummary, ccModels, ccLca] = await Promise.all([
            callAuthedJson(`${origin}/v1internal:retrieveUserQuotaSummary`, { method: 'POST', body: projectPayload }),
            callAuthedJson(`${origin}/v1internal:fetchAvailableModels`, { method: 'POST', body: projectPayload }),
            needPlan
              ? callAuthedJson(`${origin}/v1internal:loadCodeAssist`, {
                  method: 'POST',
                  body: JSON.stringify({
                    metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
                  }),
                })
              : Promise.resolve({ status: 200, data: null }),
          ])
          if (ccLca.data) lcaData = ccLca.data
          const ccWindows = parseAntigravityQuotaSummary(ccSummary.data)
          const hasGeminiGroup = ccWindows.some((w) => /gemini/i.test(w.group ?? w.label))
          const geminiFallback = hasGeminiGroup ? null : parseCloudCodeGeminiFallback(ccModels.data)
          windows = [
            ...(geminiFallback ? [geminiFallback] : []),
            ...ccWindows,
          ]
          if (windows.length > 0) break
        }
      }

      let plan = cachedPlan?.fingerprint === creds.fingerprint ? cachedPlan.plan : null
      let externalUsage = cachedPlan?.fingerprint === creds.fingerprint ? cachedPlan.externalUsage : null
      if (needPlan) {
        const parsedPlan = parseAntigravityPlanInfo(licensesRes.data, lcaData)
        plan = parsedPlan.plan ?? plan
        externalUsage = parsedPlan.externalUsage ?? externalUsage
        planCache.set(cacheKey, {
          fingerprint: creds.fingerprint,
          fetchedAtMs: nowMs,
          plan,
          externalUsage,
        })
      }

      if (windows.length === 0) {
        if (existing && existing.fingerprint === creds.fingerprint && nowMs - existing.fetchedAtMs < LIMITS_MAX_STALE_MS) {
          return existing.snapshot
        }
        return {
          checkedAt,
          windows: [],
          plan,
          email: creds.email,
          externalUsage,
          unavailable: {
            reason: 'probeFailed',
            message: 'Antigravity rate-limit endpoint did not return any quota windows.',
          },
        }
      }

      const snapshot: AntigravityLimitsSnapshot = {
        checkedAt,
        windows,
        plan,
        email: creds.email,
        externalUsage,
        unavailable: null,
      }
      limitsCache.set(cacheKey, {
        fingerprint: creds.fingerprint,
        fetchedAtMs: nowMs,
        snapshot,
      })
      return snapshot
    } catch (err) {
      if (existing && existing.fingerprint === creds.fingerprint && nowMs - existing.fetchedAtMs < LIMITS_MAX_STALE_MS) {
        return existing.snapshot
      }
      return {
        checkedAt,
        windows: [],
        plan: planCache.get(cacheKey)?.plan ?? null,
        email: creds.email,
        externalUsage: null,
        unavailable: {
          reason: 'probeFailed',
          message: err instanceof Error ? err.message : 'Could not read Antigravity rate limits.',
        },
      }
    }
  })().finally(() => {
    if (inFlightProbes.get(cacheKey) === probe) {
      inFlightProbes.delete(cacheKey)
    }
  })

  inFlightProbes.set(cacheKey, probe)
  return probe
}
