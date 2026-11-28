import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateT3Usage,
  computeWindowPace,
  formatCompactTokens,
  formatResetCountdown,
  formatShare,
  formatUsd,
  groupLimitWindows,
  parseT3SessionModel,
  selectSessionLimitsForModel,
  validateT3UsageSearch,
  type T3SummaryShape,
} from './t3-usage-math.ts'

test('validateT3UsageSearch accepts valid tab and period values and drops unknown values', () => {
  assert.deepEqual(validateT3UsageSearch({ tab: 'tokens', period: 'week', extra: 1 }), { tab: 'tokens', period: 'week' })
  assert.deepEqual(validateT3UsageSearch({ tab: 'price', period: 'quarter' }), { tab: 'price', period: 'quarter' })
  assert.deepEqual(validateT3UsageSearch({ tab: 'invalid', period: 'year' }), {})
})

test('formatting helpers match T3 usage display conventions', () => {
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(0.0002), '<$0.001')
  assert.equal(formatUsd(0.0042), '$0.0042')
  assert.equal(formatUsd(12.345), '$12.35')
  assert.equal(formatCompactTokens(842), '842')
  assert.equal(formatCompactTokens(15_400), '15.4K')
  assert.equal(formatCompactTokens(2_450_000), '2.45M')
  assert.equal(formatShare(0.254), '25.4%')
  assert.equal(formatResetCountdown('2026-11-26T22:00:00.000Z', Date.parse('2026-11-26T20:30:00.000Z')), 'Resets in 1h 30m')
})

test('computeWindowPace computes steady-pace marker and ahead/even/fast states', () => {
  const now = Date.parse('2026-11-26T20:00:00.000Z')
  const conserving = computeWindowPace({
    id: 'session',
    kind: 'session',
    label: '5-hour',
    usedPercent: 20,
    remainingPercent: 80,
    resetsAt: new Date(now + 150 * 60_000).toISOString(),
    windowDurationMins: 300,
  }, now)
  assert.ok(conserving)
  assert.equal(Math.round(conserving.timeLeftPercent), 50)
  assert.equal(conserving.state, 'ahead')

  const burningFast = computeWindowPace({
    id: 'session',
    kind: 'session',
    label: '5-hour',
    usedPercent: 75,
    remainingPercent: 25,
    resetsAt: new Date(now + 150 * 60_000).toISOString(),
    windowDurationMins: 300,
  }, now)
  assert.ok(burningFast)
  assert.equal(burningFast.state, 'fast')
})

test('aggregateT3Usage deduplicates physicalSourceId sources, respects provider filter, and zero-fills series', () => {
  const summary: T3SummaryShape = {
    connected: true,
    period: 'week',
    resolution: 'day',
    timeZone: 'UTC',
    sinceDay: '2026-11-20',
    untilDay: '2026-11-26',
    readAt: '2026-11-26T20:00:00.000Z',
    scanDurationMs: 18,
    pricing: { status: 'fresh', source: 'litellm', fetchedAt: '2026-11-26T18:00:00.000Z', knownModels: 6352 },
    priceOverrides: { 'gpt-5.4': { inputCostPerMillionTokens: 2.5, outputCostPerMillionTokens: 15 } },
    modelAliases: {},
    sources: [
      {
        fingerprint: {
          hostId: 'local',
          provider: 'codex',
          resolvedHomePath: '/home/ken/.codex',
          volumeId: 'dev1',
          physicalSourceId: 'inode-100',
        },
        status: 'ok',
        scannedFiles: 4,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 3,
        message: null,
      },
      {
        // Duplicate physicalSourceId for codex at another mount path
        fingerprint: {
          hostId: 'remote-ssh',
          provider: 'codex',
          resolvedHomePath: '/mnt/ken/.codex',
          volumeId: 'dev1',
          physicalSourceId: 'inode-100',
        },
        status: 'ok',
        scannedFiles: 4,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 3,
        message: null,
      },
      {
        fingerprint: {
          hostId: 'local',
          provider: 'antigravity',
          resolvedHomePath: '/home/ken/.antigravity',
          volumeId: 'dev1',
          physicalSourceId: 'inode-200',
        },
        status: 'ok',
        scannedFiles: 2,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 2,
        message: null,
      },
    ],
    buckets: [
      {
        day: '2026-11-25',
        provider: 'codex',
        model: 'gpt-5.4',
        sourcePath: '/home/ken/.codex',
        totals: {
          uncachedInputTokens: 10_000,
          cachedInputTokens: 40_000,
          cacheCreationTokens: 0,
          outputTokens: 5_000,
          reasoningTokens: 2_000,
        },
        costUsd: 0.45,
        cacheSavingsUsd: 0.08,
        costSource: 'modelPriced',
        records: 10,
        unpricedRecords: 0,
        sessions: 3,
      },
      {
        // Duplicate bucket from /mnt/ken/.codex — excluded by physicalSourceId dedup!
        day: '2026-11-25',
        provider: 'codex',
        model: 'gpt-5.4',
        sourcePath: '/mnt/ken/.codex',
        totals: {
          uncachedInputTokens: 10_000,
          cachedInputTokens: 40_000,
          cacheCreationTokens: 0,
          outputTokens: 5_000,
          reasoningTokens: 2_000,
        },
        costUsd: 0.45,
        cacheSavingsUsd: 0.08,
        costSource: 'modelPriced',
        records: 10,
        unpricedRecords: 0,
        sessions: 3,
      },
      {
        day: '2026-11-26',
        provider: 'antigravity',
        model: 'gemini-4-carbon',
        sourcePath: '/home/ken/.antigravity',
        totals: {
          uncachedInputTokens: 20_000,
          cachedInputTokens: 10_000,
          cacheCreationTokens: 5_000,
          outputTokens: 8_000,
          reasoningTokens: 3_000,
        },
        costUsd: 1.25,
        cacheSavingsUsd: 0.05,
        costSource: 'providerReported',
        records: 5,
        unpricedRecords: 0,
        sessions: 2,
      },
    ],
  }

  const all = aggregateT3Usage(summary)
  assert.equal(all.totalTokens, 98_000, 'deduplicated physicalSourceId bucket is excluded')
  assert.equal(Math.round(all.costUsd * 100), 170)
  assert.equal(all.sessions, 5)
  assert.equal(all.models.length, 2)
  assert.equal(all.series.length, 7, 'zero-fills all 7 days in the week range')
  assert.equal(all.models.find((m) => m.model === 'gpt-5.4')?.hasOverride, true)

  const codexOnly = aggregateT3Usage(summary, new Set(['antigravity']))
  assert.equal(codexOnly.totalTokens, 55_000)
  assert.equal(Math.round(codexOnly.costUsd * 100), 45)
  assert.equal(codexOnly.models.length, 1)
  assert.equal(codexOnly.models[0]!.model, 'gpt-5.4')
})

test('groupLimitWindows keeps ungrouped windows flat and groups consecutive Antigravity model pools', () => {
  const flat = groupLimitWindows([
    { id: 's', kind: 'session', label: 'Session', usedPercent: 20, remainingPercent: 80, resetsAt: null, windowDurationMins: 300 },
    { id: 'w', kind: 'weekly', label: 'Weekly', usedPercent: 40, remainingPercent: 60, resetsAt: null, windowDurationMins: 10080 },
  ])
  assert.equal(flat.length, 1)
  assert.equal(flat[0]?.group, null)
  assert.equal(flat[0]?.windows.length, 2)

  const grouped = groupLimitWindows([
    { id: 'g-5h', kind: 'session', label: 'Session', group: 'Gemini models', groupDetail: 'Gemini 4 Carbon, Gemini 4 Neon', usedPercent: 7, remainingPercent: 93, resetsAt: null, windowDurationMins: 300 },
    { id: 'g-wk', kind: 'weekly', label: 'Weekly', group: 'Gemini models', groupDetail: 'Gemini 4 Carbon, Gemini 4 Neon', usedPercent: 61, remainingPercent: 39, resetsAt: null, windowDurationMins: 10080 },
    { id: '3p-5h', kind: 'session', label: 'Session', group: 'Claude & GPT models', groupDetail: 'Claude Opus 5.5', usedPercent: 0, remainingPercent: 100, resetsAt: null, windowDurationMins: 300 },
    { id: '3p-wk', kind: 'weekly', label: 'Weekly', group: 'Claude & GPT models', groupDetail: 'Claude Opus 5.5', usedPercent: 0, remainingPercent: 100, resetsAt: null, windowDurationMins: 10080 },
  ])
  assert.equal(grouped.length, 2)
  assert.equal(grouped[0]?.group, 'Gemini models')
  assert.equal(grouped[0]?.windows.length, 2)
  assert.equal(grouped[1]?.group, 'Claude & GPT models')
  assert.equal(grouped[1]?.windows.length, 2)
})

test('selectSessionLimitsForModel scopes limits to the active session model pool and reacts to mid-session model switches', () => {
  const accounts = [
    {
      id: 'provider:antigravity',
      instanceId: 'antigravity',
      driver: 'antigravity',
      label: 'Antigravity',
      displayName: 'Antigravity',
      accentColor: null,
      plan: 'Google AI Pro',
      windows: [
        { id: 'g-5h', kind: 'session' as const, label: 'Session', group: 'Gemini models', usedPercent: 24, remainingPercent: 76, resetsAt: null, windowDurationMins: 300 },
        { id: 'g-wk', kind: 'weekly' as const, label: 'Weekly', group: 'Gemini models', usedPercent: 64, remainingPercent: 36, resetsAt: null, windowDurationMins: 10080 },
        { id: 'c-5h', kind: 'session' as const, label: 'Session', group: 'Claude & GPT models', usedPercent: 0, remainingPercent: 100, resetsAt: null, windowDurationMins: 300 },
        { id: 'c-wk', kind: 'weekly' as const, label: 'Weekly', group: 'Claude & GPT models', usedPercent: 0, remainingPercent: 100, resetsAt: null, windowDurationMins: 10080 },
      ],
    },
    {
      id: 'provider:codex',
      instanceId: 'codex',
      driver: 'codex',
      label: 'Codex',
      displayName: 'Codex',
      accentColor: null,
      plan: 'ChatGPT Plus Subscription',
      windows: [
        { id: 'cx-5h', kind: 'session' as const, label: 'Session', usedPercent: 100, remainingPercent: 0, resetsAt: null, windowDurationMins: 300 },
        { id: 'cx-wk', kind: 'weekly' as const, label: 'Weekly', usedPercent: 83, remainingPercent: 17, resetsAt: null, windowDurationMins: 10080 },
      ],
    },
    {
      id: 'provider:opencode',
      instanceId: 'opencode',
      driver: 'opencode',
      label: 'OpenCode',
      displayName: 'OpenCode',
      accentColor: null,
      plan: null,
      windows: [],
    },
  ]

  // 1. Antigravity Gemini model -> ONLY Antigravity Gemini pool (no Claude/GPT pool, no Codex)
  const gemini = selectSessionLimitsForModel(accounts, 'antigravity/gemini-4-carbon', 'codex/gpt-6.1-sol')
  assert.equal(gemini.kind, 'scoped')
  assert.equal(gemini.accounts.length, 1)
  assert.equal(gemini.accounts[0]!.account.driver, 'antigravity')
  assert.equal(gemini.accounts[0]!.poolLabel, 'Gemini models')
  assert.deepEqual(gemini.accounts[0]!.windows.map((w) => w.id), ['g-5h', 'g-wk'])

  // 2. Switch mid-session to Antigravity Claude/GPT model -> ONLY Antigravity Claude & GPT pool
  const claudePool = selectSessionLimitsForModel(accounts, 'antigravity/claude-opus-5-5', 'codex/gpt-6.1-sol')
  assert.equal(claudePool.kind, 'scoped')
  assert.equal(claudePool.accounts.length, 1)
  assert.equal(claudePool.accounts[0]!.account.driver, 'antigravity')
  assert.equal(claudePool.accounts[0]!.poolLabel, 'Claude & GPT models')
  assert.deepEqual(claudePool.accounts[0]!.windows.map((w) => w.id), ['c-5h', 'c-wk'])

  // 3. Switch mid-session to Codex -> ONLY Codex windows
  const codex = selectSessionLimitsForModel(accounts, 'codex/gpt-6.2-astra', 'codex/gpt-6.1-sol')
  assert.equal(codex.kind, 'scoped')
  assert.equal(codex.accounts.length, 1)
  assert.equal(codex.accounts[0]!.account.driver, 'codex')
  assert.equal(codex.accounts[0]!.poolLabel, null)
  assert.deepEqual(codex.accounts[0]!.windows.map((w) => w.id), ['cx-5h', 'cx-wk'])

  // 4. Switch mid-session to OpenCode (no subscription rate limits) -> no_windows_for_provider
  const opencode = selectSessionLimitsForModel(accounts, 'opencode/opencode/deepseek-v4.1-flash-free', 'codex/gpt-6.1-sol')
  assert.equal(opencode.kind, 'no_windows_for_provider')
  assert.equal(opencode.driver, 'opencode')
  assert.equal(opencode.account?.id, 'provider:opencode')

  // 5. Session on T3 Default (model = null) -> resolves T3 defaultModel ('codex/gpt-6.1-sol')
  const def = selectSessionLimitsForModel(accounts, null, 'codex/gpt-6.1-sol')
  assert.equal(def.kind, 'scoped')
  assert.equal(def.accounts.length, 1)
  assert.equal(def.accounts[0]!.account.driver, 'codex')

  assert.deepEqual(parseT3SessionModel('gemini-4-neon'), {
    raw: 'gemini-4-neon',
    instanceId: 'antigravity',
    driver: 'antigravity',
    modelSlug: 'gemini-4-neon',
  })
})
