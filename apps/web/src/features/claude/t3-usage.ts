import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/lib/api'
import type { T3UsagePeriod } from './t3-usage-math.ts'

export * from './t3-usage-math.ts'

export type T3LimitsData = Awaited<ReturnType<typeof fetchT3Limits>>
export type T3SummaryData = Awaited<ReturnType<typeof fetchT3Summary>>
export type T3LimitAccount = T3LimitsData['accounts'][number]
export type T3LimitWindow = T3LimitAccount['windows'][number]
export type T3UsageBucket = T3SummaryData['buckets'][number]
export type T3UsageSource = T3SummaryData['sources'][number]

async function fetchT3Limits(refresh = false) {
  return unwrap(api.api.claude.t3.usage.limits.$get({ query: refresh ? { refresh: 'true' } : {} }))
}

async function fetchT3Summary(period: T3UsagePeriod, tz: string, refresh = false) {
  return unwrap(api.api.claude.t3.usage.summary.$get({
    query: { period, tz, ...(refresh ? { refresh: 'true' } : {}) },
  }))
}

export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export const t3UsageLimitsQuery = () =>
  queryOptions({
    queryKey: ['t3-usage', 'limits'],
    queryFn: () => fetchT3Limits(false),
    staleTime: 45_000,
  })

export const t3UsageSummaryQuery = (period: T3UsagePeriod, tz = browserTimeZone()) =>
  queryOptions({
    queryKey: ['t3-usage', 'summary', period, tz],
    queryFn: () => fetchT3Summary(period, tz, false),
    staleTime: 60_000,
  })
