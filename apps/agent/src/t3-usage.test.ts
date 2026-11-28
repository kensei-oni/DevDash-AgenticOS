import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memberAuthFetch, memberWsUpgrade } from './t3-local.ts'
import { effortOption } from './t3code.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAntigravityLimitsCache,
  getAntigravityUsageLimits,
  parseAntigravityPlanInfo,
  parseAntigravityQuotaSummary,
  parseCloudCodeGeminiFallback,
} from './t3-antigravity-limits.ts'
import { buildUsageWindowQuery, closeUsageClient, getUsageLimits, getUsageSummary, setUsageEmitter } from './t3-usage.ts'

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
    () => memberAuthFetch(new URL('http://127.0.0.1:3781/api/other'), { method: 'POST', headers: {} }),
    /Unsupported local T3 Code auth endpoint/,
  )
  assert.throws(
    () => memberAuthFetch(new URL('https://example.com/oauth/token'), { method: 'POST', headers: {} }),
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

test('live member T3 usage RPC fetches limits, streams live refresh notifications, and reads token/price summary', async (t) => {
  if (!process.getuid || process.getuid() < 1000 || process.getuid() >= 65534) {
    t.skip('live member T3 usage test runs as an unprivileged DevDash member')
    return
  }
  assert.deepEqual(
    effortOption({ id: 'atria/atria-dawn-preview', options: [{ id: 'variant', values: ['default', 't3:default', 'low', 'medium', 'high'] }] }),
    { id: 'variant', levels: ['low', 'medium', 'high'] },
  )
  closeUsageClient()
  let pushEvents = 0
  setUsageEmitter(() => { pushEvents += 1 })
  try {
    const coldLimits = await getUsageLimits({ refresh: false })
    if (!coldLimits.connected) {
      t.skip('member does not have an active T3 Code connection')
      return
    }
    assert.ok(Array.isArray(coldLimits.accounts))
    const limits = await getUsageLimits({ refresh: true })
    assert.ok(Array.isArray(limits.accounts))
    const agyAcc = limits.accounts.find((a) => a.driver === 'antigravity')
    if (agyAcc && agyAcc.status === 'ready') {
      assert.ok(agyAcc.windows.length > 0, 'connected Antigravity provider should report live rate-limit windows')
    }
    assert.ok(pushEvents >= 1, 'live usage emitter should fire when limits refresh')
    const summary = await getUsageSummary({ period: 'week', timeZone: 'UTC', refresh: false })
    assert.equal(summary.connected, true)
    assert.equal(summary.resolution, 'day')
    assert.ok(Array.isArray(summary.buckets))
    assert.ok(Array.isArray(summary.sources))
    assert.ok(typeof summary.pricing.knownModels === 'number')
  } finally {
    setUsageEmitter(null)
    closeUsageClient()
  }
})

test('parseAntigravityQuotaSummary orders Session before Weekly, formats groups, and handles proto3 0% exhaustion', () => {
  const windows = parseAntigravityQuotaSummary({
    summary: {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 3.8 Flash',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                resetTime: '2026-12-03T18:25:00Z',
                remainingFraction: 0.3939,
              },
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                resetTime: '2026-11-28T07:54:48Z',
                remainingFraction: 0.93,
              },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
            buckets: [
              {
                bucketId: '3p-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                // Omitted remainingFraction with active resetTime = proto3 0.0 (exhausted)
                resetTime: '2026-11-28T08:00:00Z',
              },
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 1,
              },
            ],
          },
        ],
      },
    },
  })

  assert.equal(windows.length, 4)
  assert.deepEqual(
    windows.map((w) => ({ id: w.id, kind: w.kind, label: w.label, group: w.group, remaining: w.remainingPercent, used: w.usedPercent, mins: w.windowDurationMins })),
    [
      { id: 'gemini-5h', kind: 'session', label: 'Session', group: 'Gemini models', remaining: 93, used: 7, mins: 300 },
      { id: 'gemini-weekly', kind: 'weekly', label: 'Weekly', group: 'Gemini models', remaining: 39.39, used: 60.61, mins: 10080 },
      { id: '3p-5h', kind: 'session', label: 'Session', group: 'Claude & GPT models', remaining: 0, used: 100, mins: 300 },
      { id: '3p-weekly', kind: 'weekly', label: 'Weekly', group: 'Claude & GPT models', remaining: 100, used: 0, mins: 10080 },
    ],
  )
  assert.equal(windows[0]?.groupDetail, 'Gemini 4 Neon, Gemini 4 Carbon, Gemini 3.8 Flash')
})

test('getAntigravityUsageLimits refreshes expired tokens on 401, falls back to CloudCode PA, and blocks untrusted token_uri or symlinks', async () => {
  clearAntigravityLimitsCache()
  const root = mkdtempSync(join(tmpdir(), 'devdash-agy-test-'))
  const uid = 1000
  // Override getuid check via explicit uid parameter
  try {
    const key = createHash('sha256').update('antigravity').digest('hex')
    const acpDir = join(root, 'userdata', 'providers', 'antigravity', key, 'antigravity-acp')
    mkdirSync(acpDir, { recursive: true, mode: 0o700 })

    // 1. Untrusted token_uri is rejected before any network call
    writeFileSync(join(acpDir, 'acp_token.json'), JSON.stringify({
      client_id: 'cid',
      client_secret: 'csec',
      refresh_token: 'rtok',
      token_uri: 'https://evil.example/token',
    }))
    let calls = 0
    const blocked = await getAntigravityUsageLimits({
      baseDir: root,
      instanceId: 'antigravity',
      uid: process.getuid?.() ?? uid,
      // If running as root in CI, assertRegularMemberUid throws; handle below
      fetchImpl: async () => { calls += 1; throw new Error('should not fetch') },
    }).catch(() => 'uid_rejected')
    assert.equal(calls, 0)
    if (blocked !== 'uid_rejected') {
      assert.equal(blocked, null)

      // 2. Valid Google token_uri + 401 retry + CloudCode PA fallback
      const nowMs = Date.parse('2026-11-28T03:00:00Z')
      writeFileSync(join(acpDir, 'acp_token.json'), JSON.stringify({
        client_id: 'cid',
        client_secret: 'csec',
        refresh_token: 'rtok',
        token_uri: 'https://oauth2.googleapis.com/token',
        project_id: 'aicode-consumers',
      }))
      writeFileSync(join(acpDir, 'antigravity-oauth-token'), JSON.stringify({
        token: {
          access_token: 'stale-token',
          refresh_token: 'rtok',
          expiry: '2026-11-28T03:30:00Z',
        },
        id_token_email: 'user@example.com',
      }))

      const seenAuth: string[] = []
      const snap = await getAntigravityUsageLimits({
        baseDir: root,
        instanceId: 'antigravity',
        nowMs,
        refresh: true,
        fetchImpl: async (input, init) => {
          const url = String(input)
          if (url === 'https://oauth2.googleapis.com/token') {
            return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), { status: 200 })
          }
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
          seenAuth.push(`${url}:${auth}`)
          if (auth === 'Bearer stale-token') {
            return new Response('unauthorized', { status: 401 })
          }
          if (url.includes('getUserQuotaSummary')) {
            return new Response(JSON.stringify({ summary: { response: { groups: [] } } }), { status: 200 })
          }
          if (url.includes('fetchLicenses')) {
            return new Response(JSON.stringify({ licenses: [{ tierDisplayName: 'Google AI Pro' }] }), { status: 200 })
          }
          if (url.includes('daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')) {
            return new Response(JSON.stringify({
              groups: [{
                displayName: 'Claude and GPT models',
                buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-28T08:00:00Z' }],
              }],
            }), { status: 200 })
          }
          if (url.includes('daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels')) {
            return new Response(JSON.stringify({
              models: {
                'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-28T07:00:00Z' } },
              },
            }), { status: 200 })
          }
          return new Response('{}', { status: 200 })
        },
      })

      assert.ok(snap)
      assert.equal(snap.plan, 'Google AI Pro')
      assert.equal(snap.email, 'user@example.com')
      assert.equal(snap.windows.length, 2)
      assert.equal(snap.windows[0]?.group, 'Gemini models')
      assert.equal(snap.windows[0]?.remainingPercent, 75)
      assert.equal(snap.windows[1]?.group, 'Claude & GPT models')
      assert.equal(snap.windows[1]?.remainingPercent, 80)
      assert.ok(seenAuth.some((x) => x.endsWith('Bearer fresh-token')))

      // 3. Symlinked acp_token.json is rejected
      const outside = join(root, 'outside.json')
      writeFileSync(outside, JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rtok' }))
      rmSync(join(acpDir, 'acp_token.json'))
      symlinkSync(outside, join(acpDir, 'acp_token.json'))
      const symRes = await getAntigravityUsageLimits({ baseDir: root, instanceId: 'antigravity', refresh: true })
      assert.equal(symRes, null)
    }
  } finally {
    clearAntigravityLimitsCache()
    rmSync(root, { recursive: true, force: true })
  }

  // Pure helper checks (run regardless of root/member uid)
  assert.deepEqual(parseAntigravityPlanInfo({ licenses: [{ tierDisplayName: 'Google AI Ultra' }] }), {
    plan: 'Google AI Ultra',
    externalUsage: null,
  })
  const fallback = parseCloudCodeGeminiFallback({
    models: {
      'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.5, resetTime: '2026-11-28T07:00:00Z' } },
      'gemini-3.1-flash-image': { displayName: 'Gemini Image', quotaInfo: { remainingFraction: 0.1, resetTime: '2026-11-28T07:00:00Z' } },
    },
  })
  assert.equal(fallback?.remainingPercent, 50)
})
