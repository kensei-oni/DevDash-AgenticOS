import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memberAuthFetch, memberWsUpgrade } from './t3-local.ts'
import { buildUsageWindowQuery, closeUsageClient, getUsageLimits, getUsageSummary } from './t3-usage.ts'

test('buildUsageWindowQuery builds 24h hourly and 7d/30d/90d daily T3 usage queries with timezone fallback', () => {
  const fixed = new Date('2026-11-26T19:45:32.900Z')

  const day = buildUsageWindowQuery('day', 'America/New_York', fixed)
  assert.equal(day.resolution, 'hour')
  assert.equal(day.timeZone, 'America/New_York')
  assert.equal(day.untilTime, '2026-11-26T19:45:00.000Z')
  assert.equal(day.sinceTime, '2026-11-25T19:45:00.000Z')

  const week = buildUsageWindowQuery('week', 'UTC', fixed)
  assert.equal(week.resolution, 'day')
  assert.equal(week.untilDay, '2026-11-26')
  assert.equal(week.sinceDay, '2026-11-20')

  const month = buildUsageWindowQuery('month', 'Invalid/Zone_Name', fixed)
  assert.equal(month.timeZone, 'UTC', 'invalid timezone falls back cleanly to UTC')
  assert.equal(month.untilDay, '2026-11-26')
  assert.equal(month.sinceDay, '2026-10-28')

  const quarter = buildUsageWindowQuery('quarter', 'UTC', fixed)
  assert.equal(quarter.untilDay, '2026-11-26')
  assert.equal(quarter.sinceDay, '2026-08-29')
})

test('memberAuthFetch and memberWsUpgrade enforce strict loopback paths before touching any socket', async () => {
  assert.throws(
    () => memberAuthFetch(new URL('http://127.0.0.1:3781/api/other'), { method: 'POST' }),
    /Unsupported local T3 Code auth endpoint/,
  )
  assert.throws(
    () => memberAuthFetch(new URL('https://example.com/oauth/token'), { method: 'POST' }),
    /Unsupported local T3 Code auth URL/,
  )
  await assert.rejects(
    () => memberWsUpgrade(new URL('http://127.0.0.1:3781/mcp'), {}),
    /Unsupported local T3 Code WebSocket endpoint/,
  )
  await assert.rejects(
    () => memberWsUpgrade(new URL('http://localhost:3781/ws?orchestrationProtocol=2&wsTicket=abc'), {}),
    /Unsupported local T3 Code WebSocket endpoint/,
  )
})

test('live member T3 usage RPC fetches limits and token/price summary when running as a connected member', async (t) => {
  if (!process.getuid || process.getuid() < 1000 || process.getuid() >= 65534) {
    t.skip('live member T3 usage test runs as an unprivileged DevDash member')
    return
  }
  try {
    const limits = await getUsageLimits({ refresh: false })
    if (!limits.connected) {
      t.skip('member does not have an active T3 Code connection')
      return
    }
    assert.ok(Array.isArray(limits.accounts))
    const summary = await getUsageSummary({ period: 'week', timeZone: 'UTC', refresh: false })
    assert.equal(summary.connected, true)
    assert.equal(summary.resolution, 'day')
    assert.ok(Array.isArray(summary.buckets))
    assert.ok(Array.isArray(summary.sources))
    assert.ok(typeof summary.pricing.knownModels === 'number')
  } finally {
    closeUsageClient()
  }
})
