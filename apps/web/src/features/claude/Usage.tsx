import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import type { Harness } from './harness'
import { computeWindowPace, formatResetCountdown, providerColor, providerLabel, t3UsageLimitsQuery } from './t3-usage'

type Limit = { kind: string; percent: number | null; severity?: string; resets_at: string | null; is_active?: boolean; scope?: { model?: { display_name?: string | null } | null } | null }
type Window = { utilization: number | null; resets_at: string | null } | null

export const usageQuery = (profile: string) => ({
  queryKey: ['claude', 'usage', profile],
  queryFn: () => unwrap(api.api.claude.usage[':profile'].$get({ param: { profile } })),
  staleTime: 60_000,
  refetchInterval: 120_000,
})

export const sessionUsageQuery = (id: string) => ({
  queryKey: ['claude', 'session-usage', id],
  queryFn: () => unwrap(api.api.claude.sessions[':id'].usage.$get({ param: { id } })),
  staleTime: 15_000,
  refetchInterval: 30_000,
})

// Same formatters as the per-answer line (Blocks.tsx) so numbers read the same everywhere.
const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
const money = (n: number) => (n < 0.0005 ? '$0' : n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`)

/** This session's own running total: cost, tokens in/out and how many answers, above the plan limits. */
function SessionUsage({ id }: { id: string }) {
  const q = useQuery(sessionUsageQuery(id))
  if (q.isPending) return <Skeleton className="h-10" />
  if (q.error) return <ErrorAlert error={q.error} />
  const u = q.data.usage
  // "in" is everything read, like the per-answer line: new tokens plus the cache it reads and writes.
  const read = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">This session</span>
        {u.turns > 0 && <span className="tabular-nums">{money(u.cost)}</span>}
      </div>
      {u.turns > 0 ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums text-muted-foreground">
          <span>{kTokens(read)} in</span><span aria-hidden>·</span><span>{kTokens(u.outputTokens)} out</span>
          <span aria-hidden>·</span><span>{u.turns} turn{u.turns === 1 ? '' : 's'}</span>
        </p>
      ) : <p className="text-xs text-muted-foreground">No answers yet.</p>}
    </div>
  )
}

function label(l: Limit) {
  if (l.kind === 'session') return '5-hour limit'
  if (l.kind === 'weekly_all') return 'Weekly, all models'
  if (l.kind === 'weekly_scoped') return `Weekly, ${l.scope?.model?.display_name ?? 'one model'}`
  return l.kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function resets(iso: string | null) {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Resets now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  if (h < 24) return `Resets in ${h ? `${h} h ` : ''}${m} min`
  return `Resets ${new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

/**
 * This session's own usage (when a session is in view) above the plan/provider limits:
 * - Claude Code sessions show Claude plan limits (/usage in Claude Code).
 * - T3 Code sessions show live T3 Code provider rate limits + a direct link to /usage (Limits, Tokens & Price).
 * - OpenCode sessions show only the session's own cost and tokens.
 */
export function PlanUsage({
  profile,
  sessionId,
  className,
  limits = true,
  harness,
  model,
}: {
  profile: string
  sessionId?: string
  className?: string
  limits?: boolean
  harness?: Harness
  model?: string | null
}) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {sessionId && <SessionUsage id={sessionId} />}
      {harness === 't3code' ? (
        <div className="flex flex-col gap-3">
          {sessionId && (
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">T3 Code limits</h3>
              <Link to="/usage" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                Tokens &amp; price<ArrowUpRight className="size-3" />
              </Link>
            </div>
          )}
          <T3SessionLimits model={model} />
        </div>
      ) : (
        limits && (
          <div className="flex flex-col gap-3">
            {sessionId && <h3 className="text-xs font-medium text-muted-foreground">Plan limits</h3>}
            <PlanLimits profile={profile} />
          </div>
        )
      )}
    </div>
  )
}

function modelDriver(model: string | null | undefined): string | null {
  if (!model || !model.includes('/')) return null
  const prefix = model.slice(0, model.indexOf('/')).trim()
  if (!prefix) return null
  if (prefix === 'claude' || prefix === 'anthropic') return 'claudeAgent'
  if (prefix === 'openai') return 'codex'
  return prefix
}

function T3SessionLimits({ model }: { model?: string | null }) {
  const q = useQuery(t3UsageLimitsQuery())
  if (q.isPending) return <div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-9" />)}</div>
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data.connected) {
    return <p className="text-xs text-muted-foreground">T3 Code is not connected yet.</p>
  }

  const activeDriver = modelDriver(model)
  const withWindows = q.data.accounts.filter((a) => a.windows.length > 0)
  if (!withWindows.length) {
    return (
      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <p>No live rate-limit windows reported by your T3 Code providers right now.</p>
        <Link to="/usage" className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
          Open T3 Usage<ArrowUpRight className="size-3" />
        </Link>
      </div>
    )
  }

  const ordered = [...withWindows].sort((a, b) => {
    const aMatch = activeDriver && a.driver === activeDriver ? 0 : 1
    const bMatch = activeDriver && b.driver === activeDriver ? 0 : 1
    return aMatch - bMatch
  })

  return (
    <div className="flex flex-col gap-3.5">
      {ordered.map((acct) => {
        const color = providerColor(acct.driver, acct.accentColor)
        return (
          <div key={acct.id} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="truncate">{acct.displayName || acct.label || providerLabel(acct.driver)}</span>
                {acct.plan && <span className="shrink-0 text-muted-foreground">· {acct.plan}</span>}
              </span>
              {acct.resetCredits && acct.resetCredits.availableCount > 0 && (
                <Link to="/usage" search={{ tab: 'limits' }} className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:text-foreground">
                  {acct.resetCredits.availableCount} reset{acct.resetCredits.availableCount === 1 ? '' : 's'}
                </Link>
              )}
            </div>
            {acct.windows.map((w) => {
              const pct = Math.max(0, Math.min(100, w.usedPercent))
              const pace = computeWindowPace(w)
              const tone = pct >= 90 ? 'bg-destructive' : pct >= 75 || pace?.state === 'fast' ? 'bg-attention' : 'bg-foreground/80'
              const countdown = formatResetCountdown(w.resetsAt)
              return (
                <div key={w.id} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{w.label}</span>
                    <span className="tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
                  </div>
                  <div className="relative h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${acct.label} ${w.label}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
                    {pace && (
                      <span
                        aria-hidden
                        title={`Steady pace: ${Math.round(100 - pace.timeLeftPercent)}%`}
                        className="absolute inset-y-0 w-0.5 bg-foreground/60"
                        style={{ left: `${Math.max(1, Math.min(99, 100 - pace.timeLeftPercent))}%` }}
                      />
                    )}
                  </div>
                  {countdown && <span className="text-[11px] text-muted-foreground">{countdown}</span>}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function PlanLimits({ profile }: { profile: string }) {
  const q = useQuery(usageQuery(profile))
  if (q.isPending) return <div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-9" />)}</div>
  if (q.error) return <ErrorAlert error={q.error} />
  const u = q.data.usage
  if (!u.available || !u.limits) return <p className="text-muted-foreground">This profile has no plan limits to show (API key or another provider).</p>

  const raw = u.limits as Record<string, unknown>
  let limits = (Array.isArray(raw.limits) ? raw.limits : []) as Limit[]
  if (!limits.length) {
    // Older shape: named windows only.
    const w = (k: string) => raw[k] as Window
    limits = [['session', w('five_hour')], ['weekly_all', w('seven_day')]]
      .filter(([, v]) => v)
      .map(([kind, v]) => ({ kind: kind as string, percent: (v as Window)!.utilization, resets_at: (v as Window)!.resets_at }))
  }
  return (
    <div className="flex flex-col gap-3">
      {limits.map((l, i) => {
        const pct = Math.max(0, Math.min(100, l.percent ?? 0))
        const tone = l.severity === 'critical' || pct >= 90 ? 'bg-destructive' : l.severity === 'warning' || pct >= 75 ? 'bg-attention' : 'bg-foreground/80'
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span>{label(l)}</span>
              <span className="tabular-nums text-muted-foreground">{l.percent === null ? '—' : `${Math.round(pct)}%`}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label(l)} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
            </div>
            {l.resets_at && <span className="text-xs text-muted-foreground">{resets(l.resets_at)}</span>}
          </div>
        )
      })}
      {u.plan && <p className="text-xs text-muted-foreground">Claude {u.plan.charAt(0).toUpperCase() + u.plan.slice(1)} plan, {profile === 'default' ? 'default profile' : `profile ${profile}`}. Shared by everything that uses this Claude account.</p>}
    </div>
  )
}
