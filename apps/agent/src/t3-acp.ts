// ACP bridge to a member-owned T3 Code instance. Only explicit Bypass sessions run here; DevDash approval modes are unavailable.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { T3Client, T3RequestError } from './t3-client.ts'
import { connectedCapabilities, nativeVariants, effortOption, selection, modelId, type Capabilities } from './t3code.ts'
import { disposeSupervisorWorkers } from './t3-supervisor.ts'
import { readT3ThreadUsage } from './t3-thread-usage.ts'

type Selection = { model: string; instanceId: string; options?: { id: string; value: string | boolean }[] }
type Item = { itemId: string; messageId?: string | null; position: number; runId: string | null; type: string; createdBy: string | null; text: string | null; title: string | null; status: string; textTruncated?: boolean; nextTextOffset?: number | null; [key: string]: unknown }
type Read = { thread: { threadId: string; projectId: string; worktreePath?: string | null; model: string; providerInstanceId: string; status: string; title: string; activeRunId?: string | null; latestRunId?: string | null; pendingRequestCount?: number; runtimeMode: string; interactionMode: string; link?: string | null }; items: Item[]; hasMore: boolean; nextPosition: number | null; recentRuns: { runId: string; status: string; [key: string]: unknown }[] }
type PendingQuestion = { id: string; header?: string; question: string; options?: { label: string; description?: string; value?: string }[]; multiSelect?: boolean; allowCustomAnswer?: boolean }
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'])
const send = (m: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
let nextHostId = 0
const hostCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
function requestHost<T>(method: string, params: Record<string, unknown>): Promise<T> {
  if (closing) return Promise.reject(new Error('T3 Code bridge is closing.'))
  const id = `t3-${++nextHostId}`
  return new Promise<T>((resolve, reject) => {
    hostCalls.set(id, { resolve: resolve as (v: unknown) => void, reject })
    send({ id, method, params })
  })
}
const devdashRuns = new Set<string>()
const answeredRequests = new Set<string>()
const client = new T3Client()
let caps: Capabilities
let thread: Read['thread'] | undefined
let running: string | undefined
let unresolvedSend = false
let activePrompt = false
let deadlineAt = 0
let pollWake: AbortController | undefined
let lastPosition = -1
let stopped = false
let closing = false
let promptDone: Promise<unknown> | undefined
let pendingSelection: Selection | undefined
let effort = 'default'
let mode = process.env.DEVDASH_T3_PERMISSION_MODE ?? 'default'
let lastEmittedUsageKey = ''
const update = (u: Record<string, unknown>) => send({ method: 'session/update', params: { sessionId: thread?.threadId, update: u } })
const desiredModes = () => ({ runtimeMode: 'full-access', interactionMode: 'default' })
const activeRun = (data: Read) => data.thread.activeRunId ?? data.recentRuns.find((r) => !terminal.has(r.status))?.runId
const busyThread = (data: Read) => !!activeRun(data) || ['preparing', 'queued', 'starting', 'running', 'waiting'].includes(data.thread.status)
const limit = (name: string, fallback: number, min: number, max: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback }
const turnLimitMs = limit('DEVDASH_T3_TURN_TIMEOUT_MS', 30 * 60_000, 100, 30 * 60_000)
function effectiveInstanceId() { return pendingSelection?.instanceId ?? thread?.providerInstanceId }
function effectiveModelSlug() { return pendingSelection?.model ?? thread?.model }
function currentModel() { return caps.providers.find((p) => p.providerInstanceId === effectiveInstanceId())?.models.find((m) => m.id === effectiveModelSlug()) }
function emitLiveThreadUsage(force = false) {
  if (!thread?.threadId) return null
  const snap = readT3ThreadUsage(thread.threadId)
  const key = JSON.stringify([snap.usage.cost.toFixed(6), snap.context?.usedTokens ?? 0, snap.context?.maxTokens ?? 0])
  if ((force || key !== lastEmittedUsageKey) && (snap.usage.turns > 0 || snap.context)) {
    lastEmittedUsageKey = key
    update({
      sessionUpdate: 'usage_update',
      cost: { amount: snap.usage.cost, currency: 'USD' },
      ...(snap.context ? { used: snap.context.usedTokens, size: snap.context.maxTokens } : {}),
    })
  }
  return snap
}
/** A project's default or a resumed model may be outside T3's short list. Search its exact ID when necessary. */
async function findModel(picked: Selection) {
  const provider = caps.providers.find((p) => p.providerInstanceId === picked.instanceId)
  if (!provider) return
  let model = provider.models.find((m) => m.id === picked.model)
  if (!model && provider.omittedModels) {
    const result = await connectedCapabilities(client, picked.model)
    model = result.providers.find((p) => p.providerInstanceId === picked.instanceId)?.models.find((m) => m.id === picked.model)
    if (model) provider.models.push(model)
  }
  if (model && provider.driverKind === 'opencode') {
    const levels = await nativeVariants(caps, picked.instanceId, picked.model)
    if (levels) model.options = [...(model.options ?? []).filter((o) => o.id !== 'variant'), { id: 'variant', values: levels }]
  }
  return model
}
// With no modelSelection this MCP operation is read-only and returns options that t3_thread_read omits.
async function readSelection() {
  const result = await client.call<{ modelSelection: Selection }>('t3_thread_configure', { threadId: thread!.threadId })
  return result.modelSelection
}
async function withEffort(picked: Selection, level: string | null): Promise<Selection> {
  const model = await findModel(picked)
  if (!model) throw new Error('That model is not available from a connected T3 Code provider.')
  const opt = effortOption(model)
  const options = (picked.options ?? []).filter((o) => o.id !== opt?.id)
  if (level && level !== 'default' && level !== 't3:default') {
    if (!opt?.levels.includes(level)) throw new Error('That effort level is not available for this T3 Code model.')
    options.push({ id: opt.id, value: level })
  }
  return { instanceId: picked.instanceId, model: picked.model, ...(options.length ? { options } : {}) }
}
function configOptions() {
  const inst = effectiveInstanceId()
  const mod = effectiveModelSlug()
  return [
    { id: 'model', category: 'model', currentValue: inst && mod ? modelId(inst, mod) : '', options: caps.providers.flatMap((p) => p.models.map((m) => ({ value: modelId(p.providerInstanceId, m.id), name: `${p.displayName ?? p.providerInstanceId}: ${m.label ?? m.id}` }))) },
    { id: 'effort', category: 'thought_level', currentValue: effort, options: [{ value: 'default', name: 'Default' }, ...(effortOption(currentModel())?.levels ?? []).map((value) => ({ value, name: value }))] },
  ]
}
function checkDeadline() {
  if (activePrompt && running && deadlineAt && Date.now() >= deadlineAt) throw new Error('T3 Code turn time limit was reached.')
}
async function readThread(o: Record<string, unknown> = {}): Promise<Read> {
  checkDeadline()
  const data = await client.call<Read>('t3_thread_read', { threadId: thread!.threadId, view: 'activity', limit: 100, maxCharsPerItem: 50000, ...o })
  checkDeadline()
  for (const item of data.items) lastPosition = Math.max(lastPosition, item.position)
  return data
}
async function allItems(afterPosition = -1) {
  const items: Item[] = []
  let page: Read
  do {
    page = await readThread(afterPosition < 0 ? {} : { afterPosition })
    items.push(...page.items)
    if (page.hasMore) {
      if (page.nextPosition === null || page.nextPosition <= afterPosition) throw new Error('T3 Code returned an invalid history cursor.')
      afterPosition = page.nextPosition
    }
  } while (page.hasMore)
  return { ...page, items }
}
const textCache = new Map<string, { key: string; text: string }>()
async function fullText(item: Item) {
  const key = JSON.stringify([item.text, item.status, item.nextTextOffset, item.updatedAt])
  const cached = textCache.get(item.itemId)
  if (cached?.key === key) return cached.text
  let text = item.text ?? ''
  let offset = item.nextTextOffset
  while (item.textTruncated && offset != null) {
    const page = await readThread({ itemId: item.itemId, textOffset: offset })
    const part = page.items.find((i) => i.itemId === item.itemId)
    if (!part) throw new Error('T3 Code could not return the full message.')
    text += part.text ?? ''
    if (!part.textTruncated) break
    if (part.nextTextOffset == null || part.nextTextOffset <= offset) throw new Error('T3 Code returned an invalid text cursor.')
    offset = part.nextTextOffset
  }
  if (terminal.has(item.status) || typeof item.updatedAt === 'string') {
    if (textCache.size >= 64) textCache.delete(textCache.keys().next().value!)
    textCache.set(item.itemId, { key, text })
  }
  return text
}
const sentText = new Map<string, string>()
const sentTools = new Map<string, string>()
async function transcribe(items: Item[], replay = false) {
  for (const i of items) {
    let text = await fullText(i)
    // createdBy identifies who submitted the item (MCP sends are agent-created), not its conversation role.
    const user = i.type === 'user_message' || (i.type === 'message' && i.createdBy === 'user')
    const assistant = i.type === 'assistant_message' || (i.type === 'message' && i.createdBy === 'agent')
    if (replay && user) {
      for (const tag of ['DevDash rules', 'DevDash workflow']) {
        const marker = new RegExp(`^\\[${tag} ([a-f0-9-]{36})\\]\\n`).exec(text)
        if (marker && requestMatches(i, marker[1]!)) {
          const end = `\n[/${tag} ${marker[1]}]\n\n`
          const idx = text.indexOf(end)
          if (idx !== -1) text = text.slice(idx + end.length)
        }
      }
    }
    const previous = sentText.get(i.itemId) ?? ''
    if (assistant || (replay && user)) {
      if (text !== previous && text.startsWith(previous)) {
        update({ sessionUpdate: user ? 'user_message_chunk' : 'agent_message_chunk', messageId: i.itemId, content: { type: 'text', text: text.slice(previous.length) } })
        sentText.set(i.itemId, text)
      }
    } else if (['tool_call', 'tool', 'activity', 'command_execution', 'file_change', 'tool_invocation', 'error'].includes(i.type)) {
      const key = `${i.status}:${text}`
      if (sentTools.get(i.itemId) === key) continue
      sentTools.set(i.itemId, key)
      // Activity is informational: permissions are enforced by T3, never fabricated as DevDash approvals.
      const title = i.title ?? (i.type === 'error' ? 'T3 Code provider error' : 'T3 Code activity')
      update({ sessionUpdate: 'tool_call_update', toolCallId: i.itemId, title, name: 'T3 Code', status: i.type === 'error' || i.status === 'failed' ? 'failed' : terminal.has(i.status) || i.status === 'idle' ? 'completed' : 'in_progress', rawInput: { description: title }, rawOutput: text })
    }
  }
}
async function checkWorkspace(cwd: string) {
  const project = await client.call<{ workspaceRoot: string }>('t3_project_read', { projectId: thread!.projectId })
  if (realpathSync(thread!.worktreePath ?? project.workspaceRoot) !== realpathSync(cwd)) throw new Error('The T3 Code conversation belongs to a different folder.')
}
async function flushPendingSelection() {
  if (!pendingSelection || !thread) return
  const target = pendingSelection
  await client.call('t3_thread_configure', { threadId: thread.threadId, modelSelection: target })
  if (pendingSelection === target) {
    pendingSelection = undefined
    thread = { ...thread, providerInstanceId: target.instanceId, model: target.model }
  }
}
/** Validate the whole selection before T3 changes anything; if a turn is actively running, apply immediately when supported or queue for turn completion. */
async function setSelection(model: string | null, requestedEffort: string | null) {
  const [freshCaps, current] = await Promise.all([connectedCapabilities(client), pendingSelection ? Promise.resolve(pendingSelection) : readSelection()])
  caps = freshCaps
  // Keep unrelated options such as service tier when only the reasoning level changes.
  const picked = !model || model === modelId(current.instanceId, current.model) ? current : selection(model)
  const modelSelection = await withEffort(picked, requestedEffort)
  const sameInstance = picked.instanceId === (thread?.providerInstanceId ?? current.instanceId)
  if (!unresolvedSend && ((!running && !activePrompt && !busyThread(await readThread())) || sameInstance)) {
    try {
      await client.call('t3_thread_configure', { threadId: thread!.threadId, modelSelection })
      pendingSelection = undefined
      effort = requestedEffort ?? 'default'
      thread = { ...thread!, providerInstanceId: picked.instanceId, model: picked.model }
      return { configOptions: configOptions() }
    } catch (err) {
      if (!(running || activePrompt) || !/busy|running|active/i.test((err as Error).message)) throw err
    }
  }
  pendingSelection = modelSelection
  effort = requestedEffort ?? 'default'
  return { configOptions: configOptions() }
}
function decodedIds(item: Item): string[] {
  const out: string[] = []
  for (const value of [item.messageId, item.itemId]) {
    if (typeof value !== 'string') continue
    let decoded = value
    out.push(decoded)
    for (let i = 0; i < 3; i++) {
      try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; out.push(decoded) } catch { break }
    }
  }
  return out
}
function requestMatches(item: Item, requestId: string) {
  return decodedIds(item).some((d) => d.endsWith(`:thread-send:${requestId}`) || d.endsWith(`:thread-send:devdash-${requestId}`))
}
function trackDevDashRuns(items: Item[]) {
  for (const item of items) {
    if (!item.runId || item.type !== 'user_message') continue
    if (decodedIds(item).some((d) => /:thread-send:devdash-[a-f0-9-]{36}$/.test(d))) {
      devdashRuns.add(item.runId)
      continue
    }
    const text = item.text ?? ''
    for (const tag of ['DevDash rules', 'DevDash workflow']) {
      const m = new RegExp(`^\\[${tag} ([a-f0-9-]{36})\\]\\n`).exec(text)
      if (m && requestMatches(item, m[1]!)) { devdashRuns.add(item.runId); break }
    }
  }
}
async function stopOwned(runId: string) {
  await client.call('t3_thread_interrupt', { threadId: thread!.threadId, runId, clientRequestId: randomUUID() })
  if (running === runId) running = undefined
}
async function listPendingQuestions(): Promise<string[] | null> {
  try {
    const res = await client.call<{ requestIds?: unknown }>('t3_pending_request', { action: 'list', threadId: thread!.threadId })
    return Array.isArray(res?.requestIds) ? res.requestIds.filter((x): x is string => typeof x === 'string') : []
  } catch { return null }
}
async function askHostQuestion(requestId: string, questions: PendingQuestion[]) {
  const properties: Record<string, unknown> = {}
  for (const q of questions) {
    const choices = (q.options ?? []).map((o) => ({
      const: o.value ?? o.label,
      title: o.label,
      ...(o.description && o.description !== o.label ? { description: o.description } : {}),
    }))
    if (q.multiSelect) {
      properties[q.id] = { type: 'array', ...(q.header ? { title: q.header } : {}), description: q.question, items: { anyOf: choices } }
    } else if (choices.length) {
      properties[q.id] = { type: 'string', ...(q.header ? { title: q.header } : {}), description: q.question, oneOf: choices }
    } else {
      properties[q.id] = { type: 'string', ...(q.header ? { title: q.header } : {}), description: q.question }
    }
    if (q.allowCustomAnswer !== false && choices.length) properties[`${q.id}_custom`] = { type: 'string' }
  }
  const ask = requestHost<{ action?: string; content?: Record<string, unknown> }>('elicitation/create', {
    mode: 'form',
    message: questions[0]?.question ?? 'A question from T3 Code',
    requestedSchema: { type: 'object', properties },
  }).then((reply) => ({ kind: 'host' as const, reply }))
  let watchDone = false
  const watchExternal = (async () => {
    while (!watchDone && !stopped && !closing) {
      await delay(1000)
      if (watchDone || stopped || closing) break
      const active = await listPendingQuestions()
      if (active !== null && !active.includes(requestId)) return { kind: 'external' as const }
    }
    return { kind: 'aborted' as const }
  })()
  try {
    return await Promise.race([ask, watchExternal])
  } finally {
    watchDone = true
    void ask.catch(() => {})
  }
}
const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
  initialize: async () => {
    await client.connect()
    caps = await connectedCapabilities(client)
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: false } }, agentInfo: { name: 't3code', version: client.serverVersion ?? 'unknown' } }
  },
  'session/new': async (p) => {
    if (thread) throw new Error('A T3 Code conversation is already open.')
    if (mode !== 'bypassPermissions') throw new Error('This T3 Code connection supports only explicitly selected Bypass sessions. DevDash approval modes are unavailable.')
    if (caps.runtimeMode !== 'full-access') throw new Error('The member T3 Code connection does not allow Bypass sessions.')
    const wanted = process.env.DEVDASH_T3_MODEL
    const wantedEffort = process.env.DEVDASH_T3_EFFORT || null
    if (!caps.providers.some((p) => p.models.length)) throw new Error('No connected T3 Code provider has available models.')
    const cwd = realpathSync(String(p.cwd))
    const findProject = async () => {
      // Bind every conversation to exactly the folder DevDash selected, including existing worktrees.
      let found: string | undefined
      let cursor: number | undefined
      do {
        const page = await client.call<{ projects: { id: string; workspaceRoot: string }[]; nextCursor: number | null }>('t3_project_list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
        found = page.projects.find((x) => x.workspaceRoot === cwd)?.id
        cursor = page.nextCursor ?? undefined
      } while (!found && cursor !== undefined)
      return found
    }
    const [initial, existingProjectId] = await Promise.all([
      wanted ? withEffort(selection(wanted), wantedEffort) : Promise.resolve(undefined),
      findProject(),
    ])
    let projectId = existingProjectId
    if (!projectId) projectId = (await client.call<{ id: string }>('t3_project_create', { title: `DevDash: ${cwd.split('/').at(-1)}`, workspaceRoot: cwd })).id
    const launched = await client.call<{ threadId: string }>('t3_thread_launch', {
      projectId, title: process.env.DEVDASH_T3_TITLE || 'DevDash session', ...desiredModes(), workspaceStrategy: { type: 'root' },
      clientRequestId: process.env.DEVDASH_SESSION_ID ?? randomUUID(), ...(initial ? { modelSelection: initial } : {}),
    })
    thread = { threadId: launched.threadId } as Read['thread']
    thread = (await readThread()).thread
    const desired = desiredModes()
    if (thread.runtimeMode !== desired.runtimeMode || thread.interactionMode !== desired.interactionMode) throw new Error('The member T3 Code instance did not open the requested Bypass conversation. Reconnect that member instance.')
    if (initial) effort = wantedEffort ?? 'default'
    else await findModel({ instanceId: thread.providerInstanceId, model: thread.model })
    return { sessionId: thread.threadId, configOptions: configOptions() }
  },
  'session/load': async (p) => {
    thread = { threadId: String(p.sessionId) } as Read['thread']
    const data = await allItems()
    thread = data.thread
    const desired = desiredModes()
    if (mode !== 'bypassPermissions' || thread.runtimeMode !== desired.runtimeMode || thread.interactionMode !== desired.interactionMode) {
      await checkWorkspace(String(p.cwd))
      throw new Error('This T3 Code connection supports only explicitly selected Bypass sessions. Start a new session to change permissions.')
    }
    const [, current] = await Promise.all([checkWorkspace(String(p.cwd)), readSelection()])
    thread = { ...thread, providerInstanceId: current.instanceId, model: current.model }
    const opt = effortOption(await findModel(current))
    const savedLevel = current.options?.find((o) => o.id === opt?.id)?.value
    effort = typeof savedLevel === 'string' && savedLevel !== 't3:default' ? savedLevel : 'default'
    trackDevDashRuns(data.items)
    await transcribe(data.items, true)
    return { configOptions: configOptions() }
  },
  'session/set_selection': (p) => {
    if ((p.model !== null && typeof p.model !== 'string') || (p.effort !== null && typeof p.effort !== 'string')) throw new Error('Invalid T3 Code model or effort.')
    return setSelection(p.model as string | null, p.effort as string | null)
  },
  'session/set_config_option': (p) => {
    if (p.configId === 'model') return setSelection(String(p.value), null)
    if (p.configId === 'effort') return setSelection(null, p.value === 'default' || p.value === 't3:default' ? null : String(p.value))
    throw new Error('Unknown T3 Code option.')
  },
  'session/prompt': async (p) => {
    if (unresolvedSend || activePrompt) throw new Error('T3 Code may still be running. Stop the conversation before sending again.')
    const prompt = p.prompt as { type: string; text?: string }[]
    if (!Array.isArray(prompt) || prompt.some((b) => b.type !== 'text')) throw new Error('This T3 Code bridge currently accepts text messages only.')
    stopped = false
    activePrompt = true
    deadlineAt = Date.now() + turnLimitMs
    try {
      if (running) {
        try {
          const check = await readThread(lastPosition < 0 ? {} : { afterPosition: lastPosition })
          trackDevDashRuns(check.items)
          if (activeRun(check) === running) await stopOwned(running)
          else running = undefined
        } catch {
          throw new Error('T3 Code may still be running. Stop the conversation before sending again.')
        }
      }
      // Read only activity added since this bridge last saw the thread. Never queue behind an external turn from T3's own UI.
      let before = await allItems(lastPosition)
      trackDevDashRuns(before.items)
      thread = before.thread
      if (busyThread(before)) {
        const orphan = activeRun(before)
        if (orphan && devdashRuns.has(orphan)) {
          await stopOwned(orphan)
          const settleUntil = Date.now() + 5000
          while (!stopped && !closing && busyThread(before) && Date.now() < settleUntil) {
            await delay(150)
            before = await allItems(lastPosition)
            trackDevDashRuns(before.items)
            thread = before.thread
          }
        }
        if (busyThread(before)) throw new Error('This conversation is already running in T3 Code. Wait for it to finish or stop it there before sending another message.')
      }
      if (stopped || closing) return { stopReason: 'cancelled' }
      if (pendingSelection) await flushPendingSelection()
      const afterPosition = lastPosition
      const requestId = randomUUID()
      const text = prompt.map((b) => b.text ?? '').join('\n')
      const blocks: string[] = []
      if (typeof p.rulesContext === 'string' && p.rulesContext.trim() && lastPosition < 0 && before.items.length === 0) {
        blocks.push(`[DevDash rules ${requestId}]\n${p.rulesContext.trim()}\n[/DevDash rules ${requestId}]`)
      }
      if (typeof p.workflowContext === 'string' && p.workflowContext.trim()) {
        blocks.push(`[DevDash workflow ${requestId}]\n${p.workflowContext}\n[/DevDash workflow ${requestId}]`)
      }
      const message = blocks.length ? `${blocks.join('\n\n')}\n\n${text}` : text
      const baselineRuns = new Set(before.recentRuns.map((r) => r.runId))
      unresolvedSend = true
      let result: { runId: string; delivery?: string }
      try {
        result = await client.call<{ runId: string; delivery?: string }>('t3_thread_send', { threadId: thread!.threadId, message, mode: 'queue', clientRequestId: `devdash-${requestId}` })
        unresolvedSend = false
      } catch (err) {
        // A rejection or lost reply does not authorize stopping somebody else's turn. Reconcile only our exact
        // request id, exposed in T3's public message identity. Unknown formats fail closed, without a blind interrupt.
        try {
          const data = await allItems(afterPosition)
          trackDevDashRuns(data.items)
          const own = data.items.find((i) => i.type === 'user_message' && i.runId && !baselineRuns.has(i.runId) && requestMatches(i, requestId))
          if (own?.runId) {
            devdashRuns.add(own.runId)
            running = own.runId
            await stopOwned(own.runId)
            unresolvedSend = false
          } else if (err instanceof T3RequestError && !err.mayHaveExecuted) {
            unresolvedSend = false
          }
        } catch {
          throw new Error('Lost contact while sending to T3 Code. Check the conversation in T3 Code before retrying; no unrelated run was stopped.')
        }
        if (unresolvedSend) throw new Error(`${(err as Error).message} The send outcome is unknown. Check the conversation in T3 Code before reconnecting; no unrelated run was stopped.`)
        throw err
      }
      const runId = result.runId
      devdashRuns.add(runId)
      running = runId
      let deadline = deadlineAt
      let waiting = false
      let waits = 0
      let settled = false
      let cursor = afterPosition
      let interval = 120
      let previous = ''
      let lastRunError = ''
      let lastUsagePollAt = 0
      try {
        if (result.delivery === 'queued') {
          await stopOwned(runId)
          settled = true
          throw new Error('Another turn started in T3 Code while sending. The queued DevDash turn was cancelled; wait for that conversation to finish before retrying.')
        }
        if (stopped || closing) await stopOwned(runId)
        while (!closing) {
          let data: Awaited<ReturnType<typeof allItems>>
          try {
            data = await allItems(cursor)
          } catch (err) {
            if (!stopped && !closing && err instanceof T3RequestError && err.mayHaveExecuted && Date.now() + 200 < deadline) {
              await delay(150)
              data = await allItems(cursor)
            } else throw err
          }
          trackDevDashRuns(data.items)
          const items = data.items.filter((i) => i.runId === runId)
          for (const i of items) {
            if (i.type === 'error' && typeof i.text === 'string' && i.text.trim()) lastRunError = i.text.trim()
          }
          await transcribe(items)
          thread = data.thread
          if (Date.now() - lastUsagePollAt >= 1500) {
            lastUsagePollAt = Date.now()
            emitLiveThreadUsage(false)
          }
          const run = data.recentRuns.find((r) => r.runId === runId)
          if (run && terminal.has(run.status)) {
            settled = true
            const snap = emitLiveThreadUsage(true)
            const ru = snap?.byRunId[runId]
            if (run.status === 'failed' || run.status === 'rolled_back') {
              throw new Error(lastRunError ? `T3 Code could not complete this turn: ${lastRunError.slice(0, 400)}` : 'T3 Code could not complete this turn. Open the conversation in T3 Code for details.')
            }
            return {
              stopReason: stopped || run.status !== 'completed' ? 'cancelled' : 'end_turn',
              ...(ru ? {
                usage: {
                  inputTokens: ru.inputTokens,
                  outputTokens: ru.outputTokens,
                  cachedReadTokens: ru.cacheReadTokens,
                  cachedWriteTokens: ru.cacheWriteTokens,
                },
              } : {}),
            }
          }
          if (Date.now() >= deadline) {
            await stopOwned(runId)
            settled = true
            throw new Error('T3 Code reached the turn time limit and the DevDash-started run was stopped.')
          }
          let bridgedQuestion = false
          if ((thread.pendingRequestCount ?? 0) > 0 && !stopped && !closing) {
            const listed = await listPendingQuestions()
            const pendingIds = (listed ?? []).filter((id) => !answeredRequests.has(id))
            if (pendingIds.length > 0) {
              bridgedQuestion = true
              for (const reqId of pendingIds) {
                if (stopped || closing) break
                const detail = await client.call<{ requestId: string; questions?: PendingQuestion[] }>('t3_pending_request', {
                  action: 'read', threadId: thread.threadId, requestId: reqId,
                })
                const questions = Array.isArray(detail.questions) ? detail.questions : []
                if (!questions.length) { answeredRequests.add(reqId); continue }
                const pausedAt = Date.now()
                deadlineAt = 0
                let outcome: Awaited<ReturnType<typeof askHostQuestion>>
                try {
                  outcome = await askHostQuestion(reqId, questions)
                } finally {
                  deadline += Date.now() - pausedAt
                  deadlineAt = deadline
                }
                if (outcome.kind === 'external') { answeredRequests.add(reqId); continue }
                if (stopped || closing || outcome.kind !== 'host' || outcome.reply.action !== 'accept' || !outcome.reply.content) {
                  if (running) await stopOwned(runId)
                  settled = true
                  return { stopReason: 'cancelled' }
                }
                const answers: Record<string, unknown> = {}
                for (const q of questions) {
                  const rawCustom = outcome.reply.content[`${q.id}_custom`]
                  const custom = typeof rawCustom === 'string' ? rawCustom.trim() : ''
                  const chosen = outcome.reply.content[q.id]
                  if (q.multiSelect) {
                    const arr = Array.isArray(chosen) ? chosen.filter((x): x is string => typeof x === 'string') : []
                    if (custom) arr.push(custom)
                    answers[q.id] = arr
                  } else if (custom) {
                    answers[q.id] = custom
                  } else if (chosen !== undefined) {
                    answers[q.id] = chosen
                  }
                }
                await client.call('t3_pending_request', { action: 'respond', threadId: thread.threadId, requestId: reqId, answers })
                answeredRequests.add(reqId)
              }
              interval = 120
              previous = ''
              continue
            }
          }
          const pending = !bridgedQuestion && thread.status === 'waiting' && (thread.pendingRequestCount ?? 0) > 0
          if (pending !== waiting) {
            waiting = pending
            update({ sessionUpdate: 'session_info_update', _meta: { 'devdash/t3-status': { status: pending ? 'waiting' : 'working' } } })
            if (pending) update({ sessionUpdate: 'agent_message_chunk', messageId: `waiting-${runId}-${++waits}`, content: { type: 'text', text: `\nT3 Code needs an answer. Continue in T3 Code${thread.link ? `: ${thread.link}` : '.'}\n` } })
          }
          // Completed older items need not be paged again. Keep the newest item and any unfinished items because
          // their positions stay fixed while T3 appends streamed text or finishes tool output.
          if (items.length) {
            const unfinished = items.filter((i) => !terminal.has(i.status))
            const keep = unfinished.length ? Math.min(...unfinished.map((i) => i.position)) : Math.max(...items.map((i) => i.position))
            cursor = Math.max(cursor, keep - 1)
          }
          const signature = JSON.stringify([run?.status, items.map((i) => [i.itemId, i.status, i.text, i.updatedAt])])
          interval = signature === previous ? Math.min(interval * 2, 1000) : 120
          previous = signature
          pollWake = new AbortController()
          await delay(Math.min(interval, Math.max(1, deadline - Date.now())), undefined, { signal: pollWake.signal }).catch((err: Error) => { if (err.name !== 'AbortError') throw err })
          pollWake = undefined
        }
        return { stopReason: 'cancelled' }
      } catch (err) {
        if (!settled) {
          try { await stopOwned(runId); settled = true }
          catch { throw new Error('Lost contact with the DevDash-started T3 Code run. Check it in T3 Code before sending again.') }
        }
        throw err
      } finally { if (settled) running = undefined }
    } finally {
      activePrompt = false
      deadlineAt = 0
      if (pendingSelection && !closing) await flushPendingSelection().catch(() => {})
    }
  },
  'session/cancel': async () => {
    stopped = true
    // When a send is still unresolved, its response/reconciliation will identify our run before cancelling it.
    if (running) await stopOwned(running)
    else if (!unresolvedSend && !activePrompt && thread) {
      try {
        const data = await readThread(lastPosition < 0 ? {} : { afterPosition: lastPosition })
        trackDevDashRuns(data.items)
        const orphan = activeRun(data)
        if (orphan && devdashRuns.has(orphan)) await stopOwned(orphan)
      } catch { /* best-effort orphan interrupt */ }
    }
    pollWake?.abort()
  },
}
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  void (async () => {
    let m: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } }
    try { m = JSON.parse(line) } catch { return }
    if (!m.method) {
      if (m.id !== undefined) {
        const call = hostCalls.get(String(m.id))
        if (call) {
          hostCalls.delete(String(m.id))
          if (m.error) call.reject(new Error(m.error.message ?? 'Host request failed.'))
          else call.resolve(m.result)
        }
      }
      return
    }
    try {
      if (!handlers[m.method]) throw new Error(`Unsupported T3 Code operation: ${m.method}`)
      const pending = Promise.resolve(handlers[m.method]!(m.params ?? {}))
      if (m.method === 'session/prompt') promptDone = pending
      const result = await pending
      if (m.id !== undefined) send({ id: m.id, result })
    } catch (err) {
      if (m.id !== undefined) send({ id: m.id, error: { code: -32603, message: (err as Error).message } })
      else process.stderr.write('T3 Code could not complete the requested operation.\n')
    }
  })()
})
async function close() {
  if (closing) return
  closing = true
  for (const call of hostCalls.values()) call.reject(new Error('T3 Code bridge closed.'))
  hostCalls.clear()
  try {
    await handlers['session/cancel']!({})
    await promptDone?.catch(() => {})
    if (pendingSelection) await flushPendingSelection().catch(() => {})
  } finally { await Promise.allSettled([client.close(), disposeSupervisorWorkers()]) }
  process.exit(0)
}
input.on('close', () => void close())
process.on('SIGTERM', () => void close())
