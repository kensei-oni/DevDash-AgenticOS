import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  AlertTriangle, ChevronDown, ChevronRight, Coins, DollarSign, ExternalLink, Gauge, Layers, Plug, Plus, RotateCw, Settings2, SlidersHorizontal, Trash2,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { StatusLight } from '@/components/app/brand'
import { confirmAction } from '@/components/app/confirm'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { profilesQuery, relativeTime } from './data'
import {
  aggregateT3Usage,
  browserTimeZone,
  computeWindowPace,
  groupLimitWindows,
  formatCompactTokens,
  formatInt,
  formatResetCountdown,
  formatShare,
  formatUsd,
  providerColor,
  providerLabel,
  t3UsageLimitsQuery,
  t3UsageSummaryQuery,
  useLiveT3Usage,
  type AggregatedModelRow,
  type T3LimitAccount,
  type T3LimitWindow,
  type T3PriceOverride,
  type T3UsageMetric,
  type T3UsagePeriod,
  type T3UsageSearch,
  type TimelinePoint,
} from './t3-usage'

export { validateT3UsageSearch, type T3UsageSearch } from './t3-usage'

const PERIOD_LABELS: Record<T3UsagePeriod, string> = {
  day: '24h',
  week: '7d',
  month: '30d',
  quarter: '90d',
}

function formatLiveAge(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return null
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  return relativeTime(Math.floor(ts / 1000))
}

export function T3UsagePage() {
  useLiveT3Usage()
  const search = useSearch({ from: '/app/usage' })
  const navigate = useNavigate()
  const qc = useQueryClient()

  const tab: T3UsageMetric = search.tab ?? 'limits'
  const period: T3UsagePeriod = search.period ?? 'month'
  const tz = useMemo(() => browserTimeZone(), [])

  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(() => new Set())
  const [pricesOpen, setPricesOpen] = useState(false)
  const [initialPriceModel, setInitialPriceModel] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])

  const setSearch = (patch: Partial<T3UsageSearch>) => {
    void navigate({
      to: '/usage',
      search: {
        tab: patch.tab ?? tab,
        period: patch.period ?? period,
      },
      replace: true,
    })
  }

  const limitsQ = useQuery({
    ...t3UsageLimitsQuery(),
    enabled: tab === 'limits',
  })

  const summaryQ = useQuery({
    ...t3UsageSummaryQuery(period, tz),
    enabled: tab !== 'limits',
  })

  const refreshLimits = useMutation({
    mutationFn: () => unwrap(api.api.claude.t3.usage.limits.$get({ query: { refresh: 'true' } })),
    onSuccess: (data) => {
      qc.setQueryData(t3UsageLimitsQuery().queryKey, data)
      setNowMs(Date.now())
      toast.success('T3 Code limits refreshed')
    },
    onError: (err) => toast.error(err.message),
  })

  const refreshSummary = useMutation({
    mutationFn: () => unwrap(api.api.claude.t3.usage.summary.$get({ query: { period, tz, refresh: 'true' } })),
    onSuccess: (data) => {
      qc.setQueryData(t3UsageSummaryQuery(period, tz).queryKey, data)
      setNowMs(Date.now())
      toast.success('T3 Code usage & prices refreshed')
    },
    onError: (err) => toast.error(err.message),
  })

  const connectT3 = useMutation({
    mutationFn: () => unwrap(api.api.claude.t3.connect.$post()),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: profilesQuery.queryKey }),
        qc.invalidateQueries({ queryKey: ['t3-usage'] }),
      ])
      toast.success('T3 Code connected')
    },
    onError: (err) => toast.error(err.message),
  })

  const agg = useMemo(() => aggregateT3Usage(summaryQ.data, hiddenProviders), [summaryQ.data, hiddenProviders])

  const openPricesFor = (model?: string) => {
    setInitialPriceModel(model ?? null)
    setPricesOpen(true)
  }

  const toggleProvider = (p: string) => {
    setHiddenProviders((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  const activeConnected = tab === 'limits'
    ? (limitsQ.isPending ? true : limitsQ.data?.connected !== false)
    : (summaryQ.isPending ? true : summaryQ.data?.connected !== false)

  const isLiveSyncing = tab === 'limits'
    ? Boolean(refreshLimits.isPending || limitsQ.data?.refreshing || (limitsQ.isFetching && !limitsQ.isPending))
    : Boolean(refreshSummary.isPending || (summaryQ.isFetching && !summaryQ.isPending))

  const lastUpdatedText = formatLiveAge(
    tab === 'limits' ? limitsQ.data?.checkedAt : summaryQ.data?.readAt,
    nowMs,
  )

  return (
    <>
      <PageHeader
        title="Usage"
        actions={
          <div className="flex items-center gap-1 sm:gap-1.5">
            {tab === 'limits' ? (
              <Button
                size="icon-sm"
                variant="outline"
                className="sm:h-7 sm:w-auto sm:px-3"
                disabled={refreshLimits.isPending || limitsQ.isPending || !activeConnected}
                onClick={() => refreshLimits.mutate()}
                aria-label="Refresh limits"
                title="Refresh limits"
              >
                <RotateCw className={cn((refreshLimits.isPending || limitsQ.data?.refreshing) && 'animate-spin')} />
                <span className="hidden sm:inline">Refresh limits</span>
              </Button>
            ) : (
              <>
                <Button
                  size="icon-sm"
                  variant="outline"
                  className="sm:h-7 sm:w-auto sm:px-3"
                  disabled={summaryQ.isPending || !activeConnected}
                  onClick={() => openPricesFor()}
                  aria-label="Model prices"
                  title="Model prices"
                >
                  <SlidersHorizontal />
                  <span className="hidden sm:inline">Model prices</span>
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  className="sm:h-7 sm:w-auto sm:px-3"
                  disabled={refreshSummary.isPending || summaryQ.isPending || !activeConnected}
                  onClick={() => refreshSummary.mutate()}
                  aria-label="Refresh usage"
                  title="Refresh usage"
                >
                  <RotateCw className={cn(refreshSummary.isPending && 'animate-spin')} />
                  <span className="hidden sm:inline">Refresh</span>
                </Button>
              </>
            )}
            <Button variant="ghost" size="icon-sm" asChild aria-label="Agent setup" title="Agent setup">
              <Link to="/sessions/setup"><Settings2 /></Link>
            </Button>
          </div>
        }
      />

      <PageBody className="gap-5 py-4 sm:gap-8 sm:py-6 md:py-8">
        <div className="flex flex-col gap-3 sm:gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-foreground">
                <Gauge className="size-3.5 text-muted-foreground" />
                T3 Code only
              </span>
              {activeConnected && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                  {isLiveSyncing ? (
                    <>
                      <RotateCw className="size-3 animate-spin text-foreground/80" />
                      <span>Syncing live…</span>
                    </>
                  ) : (
                    <>
                      <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden />
                      <span>Live{lastUpdatedText ? ` · ${lastUpdatedText}` : ''}</span>
                    </>
                  )}
                </span>
              )}
              <span className="hidden md:inline">
                Rate limits, processed tokens, and model pricing from your T3 Code instance.
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
            <ToggleGroup
              type="single"
              spacing={1}
              value={tab}
              onValueChange={(v) => v && setSearch({ tab: v as T3UsageMetric })}
              aria-label="Usage section"
              className="w-full rounded-full bg-surface p-1 sm:w-fit"
            >
              <ToggleGroupItem value="limits" className="h-8 flex-1 rounded-full px-3 text-xs hover:bg-surface-2 sm:h-7 sm:flex-initial sm:px-4 sm:text-sm">
                Limits
              </ToggleGroupItem>
              <ToggleGroupItem value="tokens" className="h-8 flex-1 rounded-full px-3 text-xs hover:bg-surface-2 sm:h-7 sm:flex-initial sm:px-4 sm:text-sm">
                Tokens
              </ToggleGroupItem>
              <ToggleGroupItem value="price" className="h-8 flex-1 rounded-full px-3 text-xs hover:bg-surface-2 sm:h-7 sm:flex-initial sm:px-4 sm:text-sm">
                Price
              </ToggleGroupItem>
            </ToggleGroup>

            {tab !== 'limits' && (
              <ToggleGroup
                type="single"
                spacing={1}
                value={period}
                onValueChange={(v) => v && setSearch({ period: v as T3UsagePeriod })}
                aria-label="Usage time window"
                className="w-full rounded-full bg-surface p-1 sm:w-fit"
              >
                {(['day', 'week', 'month', 'quarter'] as const).map((p) => (
                  <ToggleGroupItem
                    key={p}
                    value={p}
                    className="h-8 flex-1 rounded-full px-2.5 text-xs tabular-nums hover:bg-surface-2 sm:h-7 sm:flex-initial sm:px-3.5 sm:text-sm"
                  >
                    {PERIOD_LABELS[p]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
          </div>

          {tab !== 'limits' && agg.allProviders.length > 1 && (
            <div
              className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
              role="group"
              aria-label="Filter T3 Code providers"
            >
              <button
                type="button"
                onClick={() => setHiddenProviders(new Set())}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 sm:py-1 text-xs font-medium transition-colors',
                  hiddenProviders.size === 0 ? 'bg-foreground text-background' : 'bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                )}
              >
                All providers
              </button>
              {agg.allProviders.map((p) => {
                const active = !hiddenProviders.has(p)
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => toggleProvider(p)}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 sm:py-1 text-xs font-medium transition-colors',
                      active ? 'bg-surface-2 text-foreground ring-1 ring-border' : 'bg-surface text-muted-foreground opacity-60 hover:opacity-100',
                    )}
                  >
                    <span className="size-2 rounded-full" style={{ backgroundColor: providerColor(p) }} />
                    {providerLabel(p)}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {!activeConnected ? (
          <div className="flex flex-col items-start gap-4 rounded-2xl bg-surface p-5 sm:p-6 md:p-8">
            <div className="flex max-w-prose flex-col gap-1.5">
              <h2 className="text-base sm:text-lg font-semibold tracking-[-0.015em]">Connect T3 Code to view usage</h2>
              <p className="text-sm text-pretty text-muted-foreground">
                {(tab === 'limits' ? limitsQ.data?.error : summaryQ.data?.error)
                  || 'Usage reads rate limits, token history, and model costs directly from your personal T3 Code service.'}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
              <Button className="w-full sm:w-auto" disabled={connectT3.isPending} onClick={() => connectT3.mutate()}>
                {connectT3.isPending ? <Spinner /> : <Plug />}
                Connect T3 Code
              </Button>
              <Button className="w-full sm:w-auto" variant="outline" asChild>
                <Link to="/sessions/setup">Agent setup</Link>
              </Button>
            </div>
          </div>
        ) : tab === 'limits' ? (
          <LimitsSection
            isPending={limitsQ.isPending}
            error={limitsQ.error}
            accounts={limitsQ.data?.accounts ?? []}
            notices={limitsQ.data?.notices ?? []}
            nowMs={nowMs}
            onPair={() => void navigate({ to: '/terminal', search: { open: 't3-pair' } })}
          />
        ) : tab === 'tokens' ? (
          <TokensSection
            isPending={summaryQ.isPending}
            error={summaryQ.error}
            period={period}
            resolution={summaryQ.data?.resolution ?? 'day'}
            sinceDay={summaryQ.data?.sinceDay ?? ''}
            untilDay={summaryQ.data?.untilDay ?? ''}
            agg={agg}
            onEditPrice={openPricesFor}
          />
        ) : (
          <PriceSection
            isPending={summaryQ.isPending}
            error={summaryQ.error}
            period={period}
            resolution={summaryQ.data?.resolution ?? 'day'}
            sinceDay={summaryQ.data?.sinceDay ?? ''}
            untilDay={summaryQ.data?.untilDay ?? ''}
            pricing={summaryQ.data?.pricing}
            agg={agg}
            onEditPrice={openPricesFor}
          />
        )}
      </PageBody>

      {summaryQ.data && (
        <ModelPricesDialog
          open={pricesOpen}
          onOpenChange={setPricesOpen}
          initialModel={initialPriceModel}
          models={agg.models}
          priceOverrides={summaryQ.data.priceOverrides}
          modelAliases={summaryQ.data.modelAliases}
          pricing={summaryQ.data.pricing}
          period={period}
          tz={tz}
        />
      )}
    </>
  )
}

function LimitsSection({
  isPending,
  error,
  accounts,
  notices,
  nowMs,
  onPair,
}: {
  isPending: boolean
  error: Error | null
  accounts: T3LimitAccount[]
  notices: string[]
  nowMs: number
  onPair: () => void
}) {
  const qc = useQueryClient()
  const redeem = useMutation({
    mutationFn: (input: NonNullable<T3LimitAccount['resetCreditInput']>) =>
      unwrap(api.api.claude.t3.usage['reset-credit'].$post({ json: input })),
    onSuccess: (res) => {
      const messages: Record<string, string> = {
        reset: 'Reset credit applied. Rate-limit windows cleared.',
        nothingToReset: 'Nothing needed resetting right now.',
        noCredit: 'No reset credit remaining.',
        alreadyRedeemed: 'That reset credit was already redeemed.',
      }
      toast.success(res.warning || messages[res.outcome] || 'Reset credit processed.')
      void qc.invalidateQueries({ queryKey: t3UsageLimitsQuery().queryKey })
    },
    onError: (err) => toast.error(err.message),
  })

  if (error) return <ErrorAlert error={error} />
  if (isPending) {
    return (
      <div className="grid gap-3.5 sm:gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => <Skeleton key={i} className="h-44 rounded-2xl bg-surface" />)}
      </div>
    )
  }

  const withWindows = accounts.filter((a) => a.windows.length > 0)
  const withoutWindows = accounts.filter((a) => a.windows.length === 0)

  if (!accounts.length) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-2xl bg-surface p-5 sm:p-6 md:p-8">
        <div className="flex max-w-prose flex-col gap-1.5">
          <h2 className="text-base sm:text-lg font-semibold tracking-[-0.015em]">No T3 Code providers reporting limits yet</h2>
          <p className="text-sm text-pretty text-muted-foreground">
            Pair T3 Code to sign in to providers such as Antigravity, Codex, Claude, or OpenCode, then limits stream live automatically.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={onPair}>Pair T3 app</Button>
      </div>
    )
  }

  const handleRedeem = async (acc: T3LimitAccount, creditId?: string, label?: string) => {
    if (!acc.resetCreditInput) return
    const payload = creditId && 'instanceId' in acc.resetCreditInput
      ? { instanceId: acc.resetCreditInput.instanceId, creditId }
      : acc.resetCreditInput
    const ok = await confirmAction({
      title: 'Use a reset credit?',
      description: label
        ? `Redeems "${label}" on ${acc.label} to clear its current rate-limit windows. This cannot be undone.`
        : `Redeems one banked reset credit on ${acc.label} to clear its current rate-limit windows. This cannot be undone.`,
      action: 'Use credit',
    })
    if (ok) redeem.mutate(payload)
  }

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {withWindows.length > 0 && (
        <div className="grid gap-3.5 sm:gap-4 lg:grid-cols-2">
          {withWindows.map((acc) => {
            const color = providerColor(acc.driver, acc.accentColor)
            const checkedAge = formatLiveAge(acc.checkedAt, nowMs)
            return (
              <section key={acc.id} className="flex flex-col gap-3.5 sm:gap-4 rounded-2xl bg-surface p-4 md:p-5">
                <header className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                        <h2 className="truncate font-semibold tracking-[-0.01em]">{acc.label}</h2>
                        {acc.sourceLabel && (
                          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground">
                            {acc.sourceLabel}
                          </span>
                        )}
                      </div>
                      {(acc.plan || acc.email) && (
                        <p className="truncate text-xs text-muted-foreground">
                          {[acc.plan, acc.email].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>
                  {(checkedAge || acc.externalUsage) && (
                    <div className="flex flex-wrap items-center gap-2 pl-5 text-xs tabular-nums text-muted-foreground sm:shrink-0 sm:pl-0">
                      {checkedAge && <span>Checked {checkedAge}</span>}
                      {acc.externalUsage && (
                        <a
                          href={acc.externalUsage.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-foreground hover:underline"
                        >
                          {acc.externalUsage.label}
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  )}
                </header>

                <div className="flex flex-col gap-3.5">
                  {groupLimitWindows(acc.windows).map((grp, gi) => (
                    <div
                      key={grp.key}
                      className={cn('flex flex-col gap-3', gi > 0 && 'border-t border-border/60 pt-3.5')}
                    >
                      {grp.group && (
                        <div className="flex flex-col gap-0.5" title={grp.groupDetail ?? undefined}>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {grp.group}
                          </span>
                          {grp.groupDetail && (
                            <span className="truncate text-[11px] text-muted-foreground/80">
                              {grp.groupDetail}
                            </span>
                          )}
                        </div>
                      )}
                      {grp.windows.map((w) => (
                        <LimitWindowRow key={w.id} window={w} color={color} nowMs={nowMs} />
                      ))}
                    </div>
                  ))}
                </div>

                {acc.resetCredits && acc.resetCredits.availableCount > 0 && (
                  <div className="flex flex-col gap-2 border-t pt-3 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                    <span className="tabular-nums">
                      {acc.resetCredits.availableCount} reset credit{acc.resetCredits.availableCount === 1 ? '' : 's'} banked
                      {acc.resetCredits.nextExpiresAt
                        ? ` · expires ${formatResetCountdown(acc.resetCredits.nextExpiresAt, nowMs)?.replace(/^Resets /, '') ?? ''}`
                        : ''}
                    </span>
                    {acc.resetCreditInput && (
                      acc.resetCredits.options.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {acc.resetCredits.options.filter((o) => o.availableCount > 0).map((o) => (
                            <Button
                              key={o.creditId}
                              size="xs"
                              variant="outline"
                              disabled={redeem.isPending}
                              onClick={() => void handleRedeem(acc, o.creditId, o.label)}
                            >
                              Use {o.label}
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          className="w-fit"
                          disabled={redeem.isPending}
                          onClick={() => void handleRedeem(acc)}
                        >
                          Use reset
                        </Button>
                      )
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      {withoutWindows.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Other connected T3 providers</h3>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {withoutWindows.map((acc) => (
              <div key={acc.id} className="flex items-start gap-2.5 rounded-2xl bg-surface px-4 py-3 text-sm">
                <StatusLight state={acc.status === 'ready' ? 'live' : 'idle'} className="mt-1 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{acc.label}</div>
                  <div className="text-xs text-pretty text-muted-foreground">
                    {acc.unavailable?.message
                      || (acc.unavailable?.reason === 'unsupported'
                        ? 'No subscription rate limits (billed per token).'
                        : 'No rate-limit windows reported.')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {notices.length > 0 && (
        <div className="flex flex-col gap-1 rounded-2xl bg-surface px-4 py-3 text-xs text-muted-foreground">
          {notices.map((n) => (
            <div key={n} className="flex items-center gap-2">
              <AlertTriangle className="size-3.5 shrink-0 text-attention" />
              <span>{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LimitWindowRow({
  window: w,
  color,
  nowMs,
  compact = false,
}: {
  window: T3LimitWindow
  color: string
  nowMs: number
  compact?: boolean
}) {
  const remaining = Math.round(w.remainingPercent)
  const used = Math.round(w.usedPercent)
  const pace = computeWindowPace(w, nowMs)
  const resetText = formatResetCountdown(w.resetsAt, nowMs)
  const barColor = remaining <= 10 ? 'var(--destructive)' : remaining <= 25 ? 'var(--attention)' : color

  const tooltip = [
    `${remaining}% left (${used}% used)`,
    pace ? `${Math.round(pace.timeLeftPercent)}% of window time left (line marks steady pace)` : null,
    resetText,
  ].filter(Boolean).join(' · ')

  return (
    <div className="flex flex-col gap-1.5" title={tooltip}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium text-foreground">{w.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{remaining}% left</span>
          {!compact && <span className="hidden xs:inline sm:inline ml-1.5 text-[11px]">({used}% used)</span>}
        </span>
      </div>
      <div
        className="relative h-2.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={w.label}
        aria-valuenow={remaining}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {remaining > 0 && (
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${Math.max(1, w.remainingPercent)}%`, backgroundColor: barColor }}
          />
        )}
        {pace && (
          <span
            aria-hidden
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/85 shadow-xs"
            style={{ left: `${pace.timeLeftPercent}%` }}
          />
        )}
      </div>
      {(pace || resetText) && (
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
          <span>
            {pace ? (
              pace.state === 'ahead'
                ? 'Ahead of pace'
                : pace.state === 'fast'
                  ? <span className="text-attention-foreground">Spending faster than reset</span>
                  : 'Steady pace'
            ) : ''}
          </span>
          {resetText && <span className="ml-auto">{resetText}</span>}
        </div>
      )}
    </div>
  )
}

function TokensSection({
  isPending,
  error,
  period,
  resolution,
  sinceDay,
  untilDay,
  agg,
  onEditPrice,
}: {
  isPending: boolean
  error: Error | null
  period: T3UsagePeriod
  resolution: 'hour' | 'day'
  sinceDay: string
  untilDay: string
  agg: ReturnType<typeof aggregateT3Usage>
  onEditPrice: (model?: string) => void
}) {
  if (error) return <ErrorAlert error={error} />
  if (isPending) return <UsageLoadingSkeleton />

  const totalInput = agg.uncachedInputTokens + agg.cachedInputTokens + agg.cacheCreationTokens
  const modelsByTokens = [...agg.models].sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd)

  return (
    <div className="flex flex-col gap-5 sm:gap-8">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        <MetricCard
          label="Processed tokens"
          value={formatCompactTokens(agg.totalTokens)}
          sub={`${formatInt(agg.sessions)} session${agg.sessions === 1 ? '' : 's'} · ${formatInt(agg.totalTokens)} tok`}
        />
        <MetricCard
          label="Cache hit rate"
          value={formatShare(agg.cacheHitRate)}
          sub={`${formatCompactTokens(agg.cachedInputTokens)} cached read`}
        />
        <MetricCard
          label="Input tokens"
          value={formatCompactTokens(totalInput)}
          sub={`${formatCompactTokens(agg.uncachedInputTokens)} new · ${formatCompactTokens(agg.cacheCreationTokens)} write`}
        />
        <MetricCard
          label="Output tokens"
          value={formatCompactTokens(agg.outputTokens)}
          sub={agg.reasoningTokens > 0 ? `${formatCompactTokens(agg.reasoningTokens)} reasoning` : `${formatInt(agg.records)} records`}
        />
      </div>

      <section className="flex flex-col gap-3 rounded-2xl bg-surface p-3.5 sm:p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-base font-semibold tracking-[-0.01em]">
              {resolution === 'hour' ? 'Hourly processed tokens' : 'Daily processed tokens'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {period === 'day' ? 'Last 24 hours' : `${sinceDay} to ${untilDay}`}
            </p>
          </div>
        </div>
        <UsageChart
          mode="tokens"
          series={agg.series}
          providers={agg.providers.map((p) => p.provider)}
        />
      </section>

      <div className="grid gap-3.5 sm:gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-2xl bg-surface p-3.5 sm:p-4 md:p-5">
          <h2 className="text-sm sm:text-base font-semibold tracking-[-0.01em]">Tokens by type</h2>
          <dl className="flex flex-col gap-2.5 text-sm">
            <BreakdownRow label="Cached input" value={formatCompactTokens(agg.cachedInputTokens)} detail={formatInt(agg.cachedInputTokens)} share={agg.totalTokens > 0 ? agg.cachedInputTokens / agg.totalTokens : 0} />
            <BreakdownRow label="Uncached input" value={formatCompactTokens(agg.uncachedInputTokens)} detail={formatInt(agg.uncachedInputTokens)} share={agg.totalTokens > 0 ? agg.uncachedInputTokens / agg.totalTokens : 0} />
            <BreakdownRow label="Cache creation" value={formatCompactTokens(agg.cacheCreationTokens)} detail={formatInt(agg.cacheCreationTokens)} share={agg.totalTokens > 0 ? agg.cacheCreationTokens / agg.totalTokens : 0} />
            <BreakdownRow label="Output tokens" value={formatCompactTokens(agg.outputTokens)} detail={formatInt(agg.outputTokens)} share={agg.totalTokens > 0 ? agg.outputTokens / agg.totalTokens : 0} />
            {agg.reasoningTokens > 0 && (
              <BreakdownRow label="Reasoning tokens" value={formatCompactTokens(agg.reasoningTokens)} detail={`${formatInt(agg.reasoningTokens)} (within output)`} />
            )}
          </dl>
        </section>

        <ProviderSharePanel mode="tokens" providers={agg.providers} />
      </div>

      <ModelsBreakdownTable mode="tokens" models={modelsByTokens} onEditPrice={onEditPrice} />
      <WarningsFooter warnings={agg.warnings} />
    </div>
  )
}

function PriceSection({
  isPending,
  error,
  period,
  resolution,
  sinceDay,
  untilDay,
  pricing,
  agg,
  onEditPrice,
}: {
  isPending: boolean
  error: Error | null
  period: T3UsagePeriod
  resolution: 'hour' | 'day'
  sinceDay: string
  untilDay: string
  pricing: { status: string; fetchedAt: string | null; knownModels: number } | undefined
  agg: ReturnType<typeof aggregateT3Usage>
  onEditPrice: (model?: string) => void
}) {
  if (error) return <ErrorAlert error={error} />
  if (isPending) return <UsageLoadingSkeleton />

  const pricedShare = Math.max(0, 1 - agg.costQuality.unpricedShare)
  const hasSpeedBreakdown = agg.speedCost.fast > 0 || agg.speedCost.ultrafast > 0 || agg.speedCost.premium > 0

  return (
    <div className="flex flex-col gap-5 sm:gap-8">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        <MetricCard
          label="Estimated cost"
          value={formatUsd(agg.costUsd)}
          sub={`${formatInt(agg.sessions)} session${agg.sessions === 1 ? '' : 's'} · ${formatCompactTokens(agg.totalTokens)} tok`}
        />
        <MetricCard
          label="Cache savings"
          value={formatUsd(agg.cacheSavingsUsd)}
          sub={`${formatShare(agg.cacheHitRate)} input cache hit`}
        />
        <MetricCard
          label="Priced coverage"
          value={agg.records > 0 ? formatShare(pricedShare) : '—'}
          sub={pricing?.knownModels ? `${formatInt(pricing.knownModels)} models (${pricing.status})` : 'T3 pricing catalog'}
        />
        <MetricCard
          label="Unpriced tokens"
          value={formatCompactTokens(agg.costQuality.unpricedTokens)}
          sub={agg.costQuality.unpricedTokens > 0 ? 'Tap Set to price custom models' : 'All active models priced'}
          action={agg.costQuality.unpricedTokens > 0 ? (
            <Button size="xs" variant="outline" onClick={() => onEditPrice()}>Set</Button>
          ) : undefined}
        />
      </div>

      <section className="flex flex-col gap-3 rounded-2xl bg-surface p-3.5 sm:p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-base font-semibold tracking-[-0.01em]">
              {resolution === 'hour' ? 'Hourly cost' : 'Daily cost'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {period === 'day' ? 'Last 24 hours' : `${sinceDay} to ${untilDay}`}
            </p>
          </div>
        </div>
        <UsageChart
          mode="price"
          series={agg.series}
          providers={agg.providers.map((p) => p.provider)}
        />
      </section>

      <div className="grid gap-3.5 sm:gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-2xl bg-surface p-3.5 sm:p-4 md:p-5">
          <h2 className="text-sm sm:text-base font-semibold tracking-[-0.01em]">Cost by token type</h2>
          <dl className="flex flex-col gap-2.5 text-sm">
            <BreakdownRow label="Uncached input" value={formatUsd(agg.categoryCost.input)} share={agg.costUsd > 0 ? agg.categoryCost.input / agg.costUsd : 0} />
            <BreakdownRow label="Cache read" value={formatUsd(agg.categoryCost.cacheRead)} share={agg.costUsd > 0 ? agg.categoryCost.cacheRead / agg.costUsd : 0} />
            <BreakdownRow label="Cache write" value={formatUsd(agg.categoryCost.cacheWrite)} share={agg.costUsd > 0 ? agg.categoryCost.cacheWrite / agg.costUsd : 0} />
            <BreakdownRow label="Output" value={formatUsd(agg.categoryCost.output)} share={agg.costUsd > 0 ? agg.categoryCost.output / agg.costUsd : 0} />
            {agg.categoryCost.unsplit > 0.0005 && (
              <BreakdownRow label="Provider-reported flat" value={formatUsd(agg.categoryCost.unsplit)} share={agg.costUsd > 0 ? agg.categoryCost.unsplit / agg.costUsd : 0} />
            )}
          </dl>
          {hasSpeedBreakdown && (
            <div className="mt-2 border-t pt-3">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Cost by speed</h3>
              <dl className="flex flex-col gap-2 text-sm">
                <BreakdownRow label="Standard" value={formatUsd(agg.speedCost.standard)} />
                {agg.speedCost.fast > 0 && <BreakdownRow label="Fast" value={formatUsd(agg.speedCost.fast)} />}
                {agg.speedCost.ultrafast > 0 && <BreakdownRow label="Ultrafast" value={formatUsd(agg.speedCost.ultrafast)} />}
                {agg.speedCost.premium > 0 && <BreakdownRow label="Speed premium" value={formatUsd(agg.speedCost.premium)} />}
              </dl>
            </div>
          )}
        </section>

        <ProviderSharePanel mode="price" providers={agg.providers} />
      </div>

      <ModelsBreakdownTable mode="price" models={agg.models} onEditPrice={onEditPrice} />
      <WarningsFooter warnings={agg.warnings} />
    </div>
  )
}

function MetricCard({
  label,
  value,
  sub,
  action,
}: {
  label: string
  value: string
  sub?: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-1.5 sm:gap-2 rounded-2xl bg-surface p-3.5 sm:p-4">
      <div className="flex items-center justify-between gap-1.5">
        <span className="truncate text-[11px] sm:text-xs font-medium text-muted-foreground">{label}</span>
        {action}
      </div>
      <div className="truncate text-xl sm:text-2xl font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
      {sub && <div className="line-clamp-2 text-[11px] sm:text-xs leading-snug text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  )
}

function BreakdownRow({
  label,
  value,
  detail,
  share,
}: {
  label: string
  value: string
  detail?: string
  share?: number
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="flex shrink-0 items-baseline gap-2 tabular-nums">
        {detail && <span className="hidden text-xs text-muted-foreground sm:inline">{detail}</span>}
        {share !== undefined && share > 0 && <span className="text-xs text-muted-foreground">{formatShare(share)}</span>}
        <span className="font-medium text-foreground">{value}</span>
      </dd>
    </div>
  )
}

function ProviderSharePanel({
  mode,
  providers,
}: {
  mode: 'tokens' | 'price'
  providers: ReturnType<typeof aggregateT3Usage>['providers']
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-surface p-3.5 sm:p-4 md:p-5">
      <h2 className="text-sm sm:text-base font-semibold tracking-[-0.01em]">By provider</h2>
      {providers.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No provider activity in this time window.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {providers.map((p) => {
            const share = mode === 'price' ? p.costShare : p.tokenShare
            const color = providerColor(p.provider)
            return (
              <li key={p.provider} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-sm">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                    <span className="truncate">{providerLabel(p.provider)}</span>
                    <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                      {p.sessions} session{p.sessions === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="ml-auto tabular-nums">
                    <span className="font-medium">{mode === 'price' ? formatUsd(p.costUsd) : formatCompactTokens(p.totalTokens)}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      ({mode === 'price' ? `${formatCompactTokens(p.totalTokens)} · ${formatShare(share)}` : `${formatUsd(p.costUsd)} · ${formatShare(share)}`})
                    </span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  {share > 0 && (
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(1.5, share * 100)}%`, backgroundColor: color }}
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function UsageChart({
  mode,
  series,
  providers,
}: {
  mode: 'tokens' | 'price'
  series: TimelinePoint[]
  providers: string[]
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const barsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setHoverIdx(null)
  }, [series.length, mode])

  const valOf = (pt: TimelinePoint) => (mode === 'price' ? pt.costUsd : pt.totalTokens)
  const maxVal = useMemo(() => Math.max(0, ...series.map(valOf)), [series, mode])

  if (!series.length || maxVal <= 0) {
    return (
      <div className="flex h-36 sm:h-44 items-center justify-center rounded-xl bg-background/50 px-4 text-center text-sm text-muted-foreground">
        No {mode === 'price' ? 'priced usage' : 'token activity'} recorded in this window.
      </div>
    )
  }

  const pickIndex = (clientX: number): number | null => {
    const el = barsRef.current
    if (!el || !series.length) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = (clientX - rect.left) / rect.width
    return Math.min(series.length - 1, Math.max(0, Math.floor(ratio * series.length)))
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const idx = pickIndex(e.clientX)
    if (idx === null) return
    if (e.pointerType !== 'mouse' && hoverIdx === idx) {
      setHoverIdx(null)
      return
    }
    setHoverIdx(idx)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' && e.buttons === 0) return
    const idx = pickIndex(e.clientX)
    if (idx !== null) setHoverIdx(idx)
  }

  const handlePointerLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') setHoverIdx(null)
  }

  const activePoint = hoverIdx !== null ? series[hoverIdx] : null
  const firstLabel = series[0]?.label ?? ''
  const midLabel = series[Math.floor(series.length / 2)]?.label ?? ''
  const lastLabel = series[series.length - 1]?.label ?? ''
  const gapClass = series.length > 45 ? 'gap-px' : series.length > 24 ? 'gap-[2px]' : 'gap-1'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-9 sm:min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs tabular-nums">
        {activePoint ? (
          <>
            <span className="font-medium text-foreground">
              {activePoint.fullLabel}: {mode === 'price' ? formatUsd(activePoint.costUsd) : `${formatCompactTokens(activePoint.totalTokens)} tokens`}
            </span>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted-foreground">
              {providers.map((p) => {
                const pv = activePoint.byProvider[p]
                const v = mode === 'price' ? pv?.costUsd ?? 0 : pv?.totalTokens ?? 0
                if (v <= 0) return null
                return (
                  <span key={p} className="inline-flex items-center gap-1">
                    <span className="size-2 rounded-full" style={{ backgroundColor: providerColor(p) }} />
                    {providerLabel(p)} {mode === 'price' ? formatUsd(v) : formatCompactTokens(v)}
                  </span>
                )
              })}
              <button
                type="button"
                onClick={() => setHoverIdx(null)}
                className="sm:hidden text-[11px] font-medium text-foreground/80 underline underline-offset-2"
              >
                Reset
              </button>
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">
            Peak: {mode === 'price' ? formatUsd(maxVal) : `${formatCompactTokens(maxVal)} tokens`}
            <span className="sm:hidden"> · tap or drag bars</span>
          </span>
        )}
      </div>

      <div
        ref={barsRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        className={cn(
          'flex h-36 sm:h-44 touch-pan-y select-none items-end rounded-xl bg-background/50 px-2 pt-3 pb-1',
          gapClass,
        )}
      >
        {series.map((pt, idx) => {
          const total = valOf(pt)
          const heightPct = maxVal > 0 ? (total / maxVal) * 100 : 0
          const isHovered = hoverIdx === idx
          return (
            <div
              key={pt.key}
              onFocus={() => setHoverIdx(idx)}
              tabIndex={0}
              aria-label={`${pt.fullLabel}: ${mode === 'price' ? formatUsd(pt.costUsd) : `${formatCompactTokens(pt.totalTokens)} tokens`}`}
              className={cn(
                'group relative flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-xs outline-none transition-opacity',
                hoverIdx !== null && !isHovered && 'opacity-45',
              )}
            >
              {total > 0 ? (
                <div
                  className="flex w-full flex-col overflow-hidden rounded-t-[2px] sm:rounded-t-[3px]"
                  style={{ height: `${Math.max(2, heightPct)}%` }}
                >
                  {providers.map((p) => {
                    const pv = pt.byProvider[p]
                    const v = mode === 'price' ? pv?.costUsd ?? 0 : pv?.totalTokens ?? 0
                    if (v <= 0) return null
                    const sharePct = (v / total) * 100
                    return (
                      <div
                        key={p}
                        style={{ height: `${sharePct}%`, backgroundColor: providerColor(p) }}
                      />
                    )
                  })}
                </div>
              ) : (
                <div className="h-[2px] w-full rounded-full bg-muted/60" />
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-1 text-[11px] tabular-nums text-muted-foreground">
        <span>{firstLabel}</span>
        <span>{midLabel}</span>
        <span>{lastLabel}</span>
      </div>
    </div>
  )
}

function ModelsBreakdownTable({
  mode,
  models,
  onEditPrice,
}: {
  mode: 'tokens' | 'price'
  models: AggregatedModelRow[]
  onEditPrice: (model?: string) => void
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const maxMetric = useMemo(
    () => Math.max(0, ...models.map((m) => (mode === 'price' ? m.costUsd : m.totalTokens))),
    [models, mode],
  )

  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-surface p-3.5 sm:p-4 md:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm sm:text-base font-semibold tracking-[-0.01em]">Models breakdown</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {models.length} model{models.length === 1 ? '' : 's'}
        </span>
      </div>

      {models.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No model activity in this window.</p>
      ) : (
        <>
          <div className="flex flex-col divide-y divide-border/50 md:hidden">
            {models.map((m, idx) => {
              const open = expandedKey === m.key
              const metricVal = mode === 'price' ? m.costUsd : m.totalTokens
              const barPct = maxMetric > 0 ? (metricVal / maxMetric) * 100 : 0
              const share = mode === 'price' ? m.costShare : m.tokenShare
              const color = providerColor(m.provider)
              const inputTotal = m.tokens.uncachedInputTokens + m.tokens.cachedInputTokens + m.tokens.cacheCreationTokens
              const modelCacheHit = inputTotal > 0 ? m.tokens.cachedInputTokens / inputTotal : 0

              return (
                <div key={m.key} className="flex flex-col gap-2 py-3 first:pt-1 last:pb-1">
                  <div className="flex items-start justify-between gap-2.5">
                    <button
                      type="button"
                      onClick={() => setExpandedKey(open ? null : m.key)}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      <span className="mt-0.5 text-xs tabular-nums text-muted-foreground">{idx + 1}.</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                          <span className="truncate font-mono text-xs font-medium text-foreground">{m.model}</span>
                          {open
                            ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                            : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span>{providerLabel(m.provider)}</span>
                          <span aria-hidden>·</span>
                          <span className="tabular-nums">
                            {mode === 'price'
                              ? `${formatCompactTokens(m.totalTokens)} tok`
                              : m.isUnpriced ? 'Unpriced' : formatUsd(m.costUsd)}
                          </span>
                          {!(m.isUnpriced && share === 0) && (
                            <>
                              <span aria-hidden>·</span>
                              <span className="tabular-nums">{formatShare(share)}</span>
                            </>
                          )}
                          {m.hasOverride && (
                            <span className="rounded-full bg-surface-2 px-1.5 py-0.2 text-[10px] font-medium text-foreground">Custom</span>
                          )}
                          {m.alias && (
                            <span className="max-w-36 truncate rounded-full bg-surface-2 px-1.5 py-0.2 text-[10px] text-muted-foreground">→ {m.alias}</span>
                          )}
                        </div>
                      </div>
                    </button>

                    <div className="shrink-0 text-right tabular-nums">
                      {mode === 'price' ? (
                        m.isUnpriced ? (
                          <Button size="xs" variant="outline" onClick={() => onEditPrice(m.model)}>
                            Set price
                          </Button>
                        ) : (
                          <span className="text-sm font-semibold text-foreground">{formatUsd(m.costUsd)}</span>
                        )
                      ) : (
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-sm font-semibold text-foreground">{formatCompactTokens(m.totalTokens)}</span>
                          {m.isUnpriced && (
                            <Button size="xs" variant="outline" onClick={() => onEditPrice(m.model)}>
                              Set price
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {barPct > 0 && (
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(2, barPct)}%`, backgroundColor: color }} />
                    </div>
                  )}

                  {open && (
                    <div className="mt-1 flex flex-col gap-2.5 rounded-xl bg-background/50 p-3 text-xs">
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 tabular-nums">
                        <div>
                          <span className="block text-[11px] text-muted-foreground">Cached input</span>
                          <span className="font-medium">{formatCompactTokens(m.tokens.cachedInputTokens)} ({formatShare(modelCacheHit)})</span>
                        </div>
                        <div>
                          <span className="block text-[11px] text-muted-foreground">Uncached input</span>
                          <span className="font-medium">{formatCompactTokens(m.tokens.uncachedInputTokens)}</span>
                        </div>
                        {m.tokens.cacheCreationTokens > 0 && (
                          <div>
                            <span className="block text-[11px] text-muted-foreground">Cache write</span>
                            <span className="font-medium">{formatCompactTokens(m.tokens.cacheCreationTokens)}</span>
                          </div>
                        )}
                        <div>
                          <span className="block text-[11px] text-muted-foreground">Output</span>
                          <span className="font-medium">{formatCompactTokens(m.tokens.outputTokens)}</span>
                        </div>
                        {m.tokens.reasoningTokens > 0 && (
                          <div>
                            <span className="block text-[11px] text-muted-foreground">Reasoning</span>
                            <span className="font-medium">{formatCompactTokens(m.tokens.reasoningTokens)}</span>
                          </div>
                        )}
                        <div>
                          <span className="block text-[11px] text-muted-foreground">Records</span>
                          <span className="font-medium">{formatInt(m.records)}</span>
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="w-full" onClick={() => onEditPrice(m.model)}>
                        <Coins className="size-3.5" />
                        {m.hasOverride || m.alias ? 'Edit price / alias' : 'Override model price'}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-2 pr-3 text-left font-medium">#</th>
                  <th className="py-2 pr-3 text-left font-medium">Model</th>
                  <th className="py-2 px-3 text-right font-medium">Price</th>
                  <th className="py-2 px-3 text-right font-medium">Share</th>
                  <th className="py-2 pl-3 text-right font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {models.map((m, idx) => {
                  const open = expandedKey === m.key
                  const metricVal = mode === 'price' ? m.costUsd : m.totalTokens
                  const barPct = maxMetric > 0 ? (metricVal / maxMetric) * 100 : 0
                  const share = mode === 'price' ? m.costShare : m.tokenShare
                  const color = providerColor(m.provider)
                  const inputTotal = m.tokens.uncachedInputTokens + m.tokens.cachedInputTokens + m.tokens.cacheCreationTokens
                  const modelCacheHit = inputTotal > 0 ? m.tokens.cachedInputTokens / inputTotal : 0

                  return (
                    <ModelTableRowGroup
                      key={m.key}
                      index={idx + 1}
                      row={m}
                      open={open}
                      onToggle={() => setExpandedKey(open ? null : m.key)}
                      barPct={barPct}
                      share={share}
                      color={color}
                      modelCacheHit={modelCacheHit}
                      onSetPrice={() => onEditPrice(m.model)}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function ModelTableRowGroup({
  index,
  row: m,
  open,
  onToggle,
  barPct,
  share,
  color,
  modelCacheHit,
  onSetPrice,
}: {
  index: number
  row: AggregatedModelRow
  open: boolean
  onToggle: () => void
  barPct: number
  share: number
  color: string
  modelCacheHit: number
  onSetPrice: () => void
}) {
  return (
    <>
      <tr className="hover:bg-surface-2/60">
        <td className="w-8 py-2.5 pr-3 text-xs tabular-nums text-muted-foreground">{index}</td>
        <td className="py-2.5 pr-3">
          <button type="button" onClick={onToggle} className="flex w-full min-w-0 flex-col gap-1 text-left">
            <span className="flex flex-wrap items-center gap-1.5">
              {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <span className="font-mono text-xs font-medium text-foreground">{m.model}</span>
              <span className="text-xs text-muted-foreground">{providerLabel(m.provider)}</span>
              {m.hasOverride && (
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-foreground">Custom rate</span>
              )}
              {m.alias && (
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">→ {m.alias}</span>
              )}
            </span>
            {barPct > 0 && (
              <span className="ml-5 block h-1 max-w-xs overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, barPct)}%`, backgroundColor: color }} />
              </span>
            )}
          </button>
        </td>
        <td className="py-2.5 px-3 text-right tabular-nums">
          {m.isUnpriced ? (
            <Button size="xs" variant="outline" onClick={onSetPrice}>
              Unpriced · Set
            </Button>
          ) : (
            <span className="font-medium">{formatUsd(m.costUsd)}</span>
          )}
        </td>
        <td className="py-2.5 px-3 text-right text-xs tabular-nums text-muted-foreground">
          {m.isUnpriced && share === 0 ? '—' : formatShare(share)}
        </td>
        <td className="py-2.5 pl-3 text-right tabular-nums">{formatCompactTokens(m.totalTokens)}</td>
      </tr>
      {open && (
        <tr className="bg-background/40">
          <td />
          <td colSpan={4} className="px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 tabular-nums">
                <span><span className="text-muted-foreground">Cached input:</span> {formatCompactTokens(m.tokens.cachedInputTokens)} ({formatShare(modelCacheHit)} hit)</span>
                <span><span className="text-muted-foreground">Uncached input:</span> {formatCompactTokens(m.tokens.uncachedInputTokens)}</span>
                {m.tokens.cacheCreationTokens > 0 && (
                  <span><span className="text-muted-foreground">Cache write:</span> {formatCompactTokens(m.tokens.cacheCreationTokens)}</span>
                )}
                <span><span className="text-muted-foreground">Output:</span> {formatCompactTokens(m.tokens.outputTokens)}</span>
                {m.tokens.reasoningTokens > 0 && (
                  <span><span className="text-muted-foreground">Reasoning:</span> {formatCompactTokens(m.tokens.reasoningTokens)}</span>
                )}
                <span><span className="text-muted-foreground">Records:</span> {formatInt(m.records)}</span>
              </div>
              <Button size="xs" variant="outline" onClick={onSetPrice}>
                <Coins className="size-3" />
                {m.hasOverride || m.alias ? 'Edit price / alias' : 'Override price'}
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function WarningsFooter({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface px-4 py-3 text-xs text-muted-foreground">
      {warnings.map((w) => (
        <div key={w} className="flex items-center gap-2">
          <AlertTriangle className="size-3.5 shrink-0 text-attention" />
          <span>{w}</span>
        </div>
      ))}
    </div>
  )
}

function UsageLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl bg-surface" />)}
      </div>
      <Skeleton className="h-56 sm:h-64 rounded-2xl bg-surface" />
      <div className="grid gap-3.5 sm:gap-4 lg:grid-cols-2">
        <Skeleton className="h-48 rounded-2xl bg-surface" />
        <Skeleton className="h-48 rounded-2xl bg-surface" />
      </div>
    </div>
  )
}

function ModelPricesDialog({
  open,
  onOpenChange,
  initialModel,
  models,
  priceOverrides,
  modelAliases,
  pricing,
  period,
  tz,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialModel: string | null
  models: AggregatedModelRow[]
  priceOverrides: Record<string, T3PriceOverride>
  modelAliases: Record<string, string>
  pricing: { status: string; fetchedAt: string | null; knownModels: number }
  period: T3UsagePeriod
  tz: string
}) {
  const qc = useQueryClient()
  const [modelName, setModelName] = useState('')
  const [mode, setMode] = useState<'rate' | 'alias'>('rate')
  const [inputRate, setInputRate] = useState('')
  const [outputRate, setOutputRate] = useState('')
  const [cacheReadRate, setCacheReadRate] = useState('')
  const [cacheWriteRate, setCacheWriteRate] = useState('')
  const [aliasTarget, setAliasTarget] = useState('')

  useEffect(() => {
    if (!open) return
    const target = initialModel ?? models.find((m) => m.isUnpriced)?.model ?? ''
    selectModel(target)
  }, [open, initialModel])

  const selectModel = (m: string) => {
    setModelName(m)
    const existingPrice = priceOverrides[m]
    const existingAlias = modelAliases[m]
    if (existingAlias && !existingPrice) {
      setMode('alias')
      setAliasTarget(existingAlias)
      setInputRate('')
      setOutputRate('')
      setCacheReadRate('')
      setCacheWriteRate('')
    } else {
      setMode('rate')
      setAliasTarget(existingAlias ?? '')
      setInputRate(existingPrice ? String(existingPrice.inputCostPerMillionTokens) : '')
      setOutputRate(existingPrice ? String(existingPrice.outputCostPerMillionTokens) : '')
      setCacheReadRate(existingPrice?.cacheReadCostPerMillionTokens !== undefined ? String(existingPrice.cacheReadCostPerMillionTokens) : '')
      setCacheWriteRate(existingPrice?.cacheWriteCostPerMillionTokens !== undefined ? String(existingPrice.cacheWriteCostPerMillionTokens) : '')
    }
  }

  const refreshCatalog = useMutation({
    mutationFn: () => unwrap(api.api.claude.t3.usage.rates.refresh.$post()),
    onSuccess: (res) => {
      toast.success(`Pricing catalog refreshed (${formatInt(res.pricing.knownModels)} models)`)
      void qc.invalidateQueries({ queryKey: ['t3-usage', 'summary'] })
    },
    onError: (err) => toast.error(err.message),
  })

  const savePricing = useMutation({
    mutationFn: (payload: {
      priceOverrides?: Record<string, T3PriceOverride | null>
      modelAliases?: Record<string, string | null>
    }) => unwrap(api.api.claude.t3.usage.pricing.$put({ json: payload })),
    onSuccess: () => {
      toast.success('T3 Code model pricing updated')
      void qc.invalidateQueries({ queryKey: t3UsageSummaryQuery(period, tz).queryKey })
      void qc.invalidateQueries({ queryKey: ['t3-usage', 'summary'] })
    },
    onError: (err) => toast.error(err.message),
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const key = modelName.trim()
    if (!key) return
    if (mode === 'alias') {
      const target = aliasTarget.trim()
      if (!target) return
      savePricing.mutate({
        modelAliases: { [key]: target },
        ...(priceOverrides[key] ? { priceOverrides: { [key]: null } } : {}),
      })
      return
    }
    const inp = Number(inputRate)
    const out = Number(outputRate)
    if (!Number.isFinite(inp) || inp < 0 || !Number.isFinite(out) || out < 0) {
      toast.error('Enter valid non-negative USD per 1M token rates.')
      return
    }
    const cr = cacheReadRate.trim() !== '' ? Number(cacheReadRate) : undefined
    const cw = cacheWriteRate.trim() !== '' ? Number(cacheWriteRate) : undefined
    savePricing.mutate({
      priceOverrides: {
        [key]: {
          inputCostPerMillionTokens: inp,
          outputCostPerMillionTokens: out,
          ...(cr !== undefined && Number.isFinite(cr) && cr >= 0 ? { cacheReadCostPerMillionTokens: cr } : {}),
          ...(cw !== undefined && Number.isFinite(cw) && cw >= 0 ? { cacheWriteCostPerMillionTokens: cw } : {}),
        },
      },
      ...(modelAliases[key] ? { modelAliases: { [key]: null } } : {}),
    })
  }

  const removeEntry = (key: string) => {
    savePricing.mutate({
      priceOverrides: priceOverrides[key] ? { [key]: null } : undefined,
      modelAliases: modelAliases[key] ? { [key]: null } : undefined,
    })
  }

  const configuredKeys = [...new Set([...Object.keys(priceOverrides), ...Object.keys(modelAliases)])].sort()
  const unpricedModels = models.filter((m) => m.isUnpriced)

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="T3 Code model prices"
      description="Override per-1M-token USD prices or map custom model IDs to catalog models in your T3 Code settings."
    >
      <div className="flex flex-col gap-4 sm:gap-5 pb-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3.5 py-2.5 text-xs">
          <span className="text-muted-foreground">
            Catalog: <span className="font-medium text-foreground">{formatInt(pricing.knownModels)} models</span> ({pricing.status})
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={refreshCatalog.isPending}
            onClick={() => refreshCatalog.mutate()}
          >
            <RotateCw className={cn('size-3', refreshCatalog.isPending && 'animate-spin')} />
            Refresh rates
          </Button>
        </div>

        {unpricedModels.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Unpriced models in current window</span>
            <div className="flex flex-wrap gap-1.5">
              {unpricedModels.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => selectModel(m.model)}
                  className={cn(
                    'rounded-full px-2.5 py-1 font-mono text-xs transition-colors',
                    modelName === m.model ? 'bg-foreground text-background' : 'bg-surface hover:bg-surface-2',
                  )}
                >
                  {m.model}
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-2xl bg-surface p-3.5">
          <Field>
            <FieldLabel htmlFor="t3-price-model">Model ID</FieldLabel>
            <Input
              id="t3-price-model"
              list="t3-seen-models"
              placeholder="e.g. gemini-4-carbon"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              className="h-10 sm:h-8 font-mono text-base md:text-xs"
            />
            <datalist id="t3-seen-models">
              {models.map((m) => <option key={m.key} value={m.model} />)}
            </datalist>
          </Field>

          <ToggleGroup
            type="single"
            spacing={1}
            value={mode}
            onValueChange={(v) => v && setMode(v as 'rate' | 'alias')}
            className="w-full rounded-full bg-background p-1"
          >
            <ToggleGroupItem value="rate" className="min-w-0 flex-1 rounded-full px-2 text-xs">
              <DollarSign className="size-3.5 shrink-0" />
              <span className="truncate">Custom $/1M</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="alias" className="min-w-0 flex-1 rounded-full px-2 text-xs">
              <Layers className="size-3.5 shrink-0" />
              <span className="truncate">Catalog alias</span>
            </ToggleGroupItem>
          </ToggleGroup>

          {mode === 'rate' ? (
            <div className="grid grid-cols-2 gap-2.5">
              <Field>
                <FieldLabel htmlFor="t3-rate-in">Input ($ / 1M)</FieldLabel>
                <Input id="t3-rate-in" type="number" inputMode="decimal" step="any" min="0" placeholder="2.50" value={inputRate} onChange={(e) => setInputRate(e.target.value)} className="h-10 sm:h-8" />
              </Field>
              <Field>
                <FieldLabel htmlFor="t3-rate-out">Output ($ / 1M)</FieldLabel>
                <Input id="t3-rate-out" type="number" inputMode="decimal" step="any" min="0" placeholder="10.00" value={outputRate} onChange={(e) => setOutputRate(e.target.value)} className="h-10 sm:h-8" />
              </Field>
              <Field>
                <FieldLabel htmlFor="t3-rate-cr">Cache read ($ / 1M)</FieldLabel>
                <Input id="t3-rate-cr" type="number" inputMode="decimal" step="any" min="0" placeholder="Optional" value={cacheReadRate} onChange={(e) => setCacheReadRate(e.target.value)} className="h-10 sm:h-8" />
              </Field>
              <Field>
                <FieldLabel htmlFor="t3-rate-cw">Cache write ($ / 1M)</FieldLabel>
                <Input id="t3-rate-cw" type="number" inputMode="decimal" step="any" min="0" placeholder="Optional" value={cacheWriteRate} onChange={(e) => setCacheWriteRate(e.target.value)} className="h-10 sm:h-8" />
              </Field>
            </div>
          ) : (
            <Field>
              <FieldLabel htmlFor="t3-alias-target">Catalog model ID</FieldLabel>
              <Input
                id="t3-alias-target"
                placeholder="e.g. gemini-2.5-pro or claude-sonnet-4-5"
                value={aliasTarget}
                onChange={(e) => setAliasTarget(e.target.value)}
                className="h-10 sm:h-8 font-mono text-base md:text-xs"
              />
              <FieldDescription>Uses T3 Code’s live catalog rates for that model.</FieldDescription>
            </Field>
          )}

          <div className="flex justify-end">
            <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={!modelName.trim() || savePricing.isPending}>
              {savePricing.isPending ? <Spinner /> : <Plus />}Save rule
            </Button>
          </div>
        </form>

        {configuredKeys.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Saved rules ({configuredKeys.length})</span>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-2xl bg-surface p-1.5">
              {configuredKeys.map((k) => {
                const p = priceOverrides[k]
                const a = modelAliases[k]
                return (
                  <li key={k} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs hover:bg-surface-2">
                    <button type="button" onClick={() => selectModel(k)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate font-mono font-medium text-foreground">{k}</span>
                      <span className="block truncate text-muted-foreground tabular-nums">
                        {p
                          ? `$${p.inputCostPerMillionTokens}/1M in · $${p.outputCostPerMillionTokens}/1M out${p.cacheReadCostPerMillionTokens !== undefined ? ` · $${p.cacheReadCostPerMillionTokens}/1M cache` : ''}`
                          : `Alias → ${a}`}
                      </span>
                    </button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={savePricing.isPending}
                      onClick={() => removeEntry(k)}
                      aria-label={`Reset ${k} to automatic`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </ResponsiveDialog>
  )
}
