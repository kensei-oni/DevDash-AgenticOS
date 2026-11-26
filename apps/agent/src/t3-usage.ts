// Member-owned T3 Code Usage bridge (Limits, Tokens & Price) over T3's verified loopback Effect RPC WebSocket.
// Strictly scoped to this Linux member's own T3 Code instance; credentials stay in ~/.config/devdash/t3-rpc.json (0600).
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Socket } from 'node:net'
import { promisify } from 'node:util'
import { readConfig } from './t3-client.ts'
import { assertMemberEndpoint, assertRegularMemberUid, memberAuthFetch, memberWsUpgrade, validateMemberUrl } from './t3-local.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_T3_BIN = '/opt/devdash/t3code/current/t3'
const RPC_SCOPES = ['orchestration:read', 'diagnostics:read', 'settings:write', 'providers:manage'] as const
const TOKEN_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const BOOTSTRAP_TOKEN_TYPE = 'urn:t3:params:oauth:token-type:environment-bootstrap'
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const IDLE_CLOSE_MS = 20_000

export type T3UsagePeriod = 'day' | 'week' | 'month' | 'quarter'

export type T3PriceOverride = {
  inputCostPerMillionTokens: number
  outputCostPerMillionTokens: number
  cacheReadCostPerMillionTokens?: number
  cacheWriteCostPerMillionTokens?: number
}

export type T3LimitWindow = {
  id: string
  kind: 'session' | 'weekly' | 'monthly' | 'other'
  label: string
  usedPercent: number
  remainingPercent: number
  resetsAt: string | null
  windowDurationMins: number | null
}

export type T3ResetCreditOption = {
  creditId: string
  label: string
  description: string
  availableCount: number
  expiresAt: string | null
}

export type T3ResetCreditInput =
  | { instanceId: string; creditId?: string }
  | { sourceId: string; accountId: string; creditId: string }

export type T3LimitAccount = {
  id: string
  instanceId: string | null
  driver: string
  label: string
  displayName: string | null
  accentColor: string | null
  status: string
  plan: string | null
  email: string | null
  sourceLabel: string | null
  checkedAt: string | null
  windows: T3LimitWindow[]
  zeroSpendCap: boolean
  resetCredits: {
    availableCount: number
    nextExpiresAt: string | null
    nextCreditId: string | null
    options: T3ResetCreditOption[]
  } | null
  resetCreditInput: T3ResetCreditInput | null
  externalUsage: { label: string; url: string } | null
  unavailable: { reason: 'unsupported' | 'probeFailed'; message: string | null } | null
}

export type T3LimitsResponse = {
  connected: boolean
  checkedAt: string
  accounts: T3LimitAccount[]
  notices: string[]
  error?: string
}

export type T3UsageBucket = {
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

export type T3UsageSource = {
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

export type T3PricingCatalog = {
  status: 'fresh' | 'cached' | 'unavailable'
  source: string
  fetchedAt: string | null
  knownModels: number
}

export type T3UsageSummaryResponse = {
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
  buckets: T3UsageBucket[]
  sources: T3UsageSource[]
  pricing: T3PricingCatalog
  priceOverrides: Record<string, T3PriceOverride>
  modelAliases: Record<string, string>
  error?: string
}

type StoredRpcSession = {
  origin: string
  baseDir: string
  token: string
  expiresAt: string
  sessionId: string | null
}

function rpcSessionFile(): string {
  return process.env.DEVDASH_T3_RPC_CONFIG || join(homedir(), '.config', 'devdash', 't3-rpc.json')
}

function t3Binary(): string {
  return process.env.DEVDASH_T3_BIN || (existsSync(DEFAULT_T3_BIN) ? DEFAULT_T3_BIN : 't3')
}

function memberPaths(): { mcpUrl: string; origin: string; baseDir: string; t3Bin: string } {
  const uid = assertRegularMemberUid(process.getuid?.())
  const rawCfg = readConfig()
  const mcp = validateMemberUrl(rawCfg.url)
  const baseDir = resolve(
    process.env.DEVDASH_T3_BASE_DIR
    || rawCfg.baseDir
    || join(homedir(), '.local', 'share', 'devdash-t3'),
  )
  const st = lstatSync(baseDir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error('T3 Code data directory must be a private (0700) directory owned by this Linux member.')
  }
  return { mcpUrl: mcp.href, origin: mcp.origin, baseDir, t3Bin: t3Binary() }
}

function parseTokenSessionId(token: string): string | null {
  try {
    const parts = token.split('.')
    const payload = parts.length === 2 ? parts[0] : parts.length === 3 ? parts[1] : null
    if (!payload) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sid?: unknown }
    return typeof claims.sid === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(claims.sid) ? claims.sid : null
  } catch {
    return null
  }
}

function readStoredRpcSession(origin: string, baseDir: string): StoredRpcSession | null {
  const uid = assertRegularMemberUid(process.getuid?.())
  const file = rpcSessionFile()
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredRpcSession>
    if (
      parsed.origin !== origin
      || parsed.baseDir !== baseDir
      || typeof parsed.token !== 'string'
      || !parsed.token.trim()
      || typeof parsed.expiresAt !== 'string'
    ) return null
    const exp = Date.parse(parsed.expiresAt)
    if (!Number.isFinite(exp) || exp - Date.now() < 5 * 60_000) return null
    return {
      origin,
      baseDir,
      token: parsed.token.trim(),
      expiresAt: parsed.expiresAt,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    }
  } catch {
    return null
  }
}

async function revokeT3Auth(t3Bin: string, baseDir: string, kind: 'pairing' | 'session', id: string | null): Promise<void> {
  if (!id) return
  await execFileAsync(t3Bin, ['auth', kind, 'revoke', '--base-dir', baseDir, id], {
    cwd: baseDir,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => {})
}

let mintingPromise: Promise<StoredRpcSession> | null = null

async function mintRpcSession(forceNew = false): Promise<StoredRpcSession> {
  const { mcpUrl, origin, baseDir, t3Bin } = memberPaths()
  if (!forceNew) {
    const existing = readStoredRpcSession(origin, baseDir)
    if (existing) return existing
  }
  if (mintingPromise) return mintingPromise
  mintingPromise = (async () => {
    const uid = assertRegularMemberUid(process.getuid?.())
    await assertMemberEndpoint(mcpUrl)
    const file = resolve(rpcSessionFile())
    const cfgDir = dirname(file)
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 })
    const dirInfo = await lstat(cfgDir)
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || dirInfo.uid !== uid) {
      throw new Error('~/.config/devdash must be a real directory owned by this Linux member.')
    }

    let previousSessionId: string | null = null
    try {
      const oldRaw = JSON.parse(readFileSync(file, 'utf8')) as { sessionId?: unknown; token?: unknown }
      previousSessionId = typeof oldRaw.sessionId === 'string'
        ? oldRaw.sessionId
        : typeof oldRaw.token === 'string' ? parseTokenSessionId(oldRaw.token) : null
    } catch { /* no previous file */ }

    const { stdout } = await execFileAsync(
      t3Bin,
      [
        'auth', 'pairing', 'create', '--base-dir', baseDir, '--ttl', '2m',
        '--label', 'DevDash T3 Usage',
        ...RPC_SCOPES.flatMap((s) => ['--scope', s]),
        '--json',
      ],
      { cwd: baseDir, timeout: 20_000, maxBuffer: 1024 * 1024 },
    )
    const pairing = JSON.parse(stdout) as { id?: string; credential?: string }
    if (typeof pairing.id !== 'string' || typeof pairing.credential !== 'string') {
      throw new Error('T3 Code did not return a valid pairing token for Usage.')
    }

    let issuedSessionId: string | null = null
    let saved = false
    const tmp = `${file}.tmp-${randomBytes(8).toString('hex')}`
    try {
      const res = await memberAuthFetch(new URL('/oauth/token', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: TOKEN_GRANT,
          subject_token: pairing.credential,
          subject_token_type: BOOTSTRAP_TOKEN_TYPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          scope: RPC_SCOPES.join(' '),
          client_label: 'DevDash T3 Usage',
          client_device_type: 'bot',
          client_os: 'linux',
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        await res.body?.cancel()
        throw new Error(`T3 Code token exchange failed (HTTP ${res.status}).`)
      }
      const tok = await res.json() as { access_token?: string; token_type?: string; expires_in?: number }
      if (typeof tok.access_token !== 'string' || !tok.access_token.trim() || !Number.isFinite(tok.expires_in) || (tok.expires_in ?? 0) <= 0) {
        throw new Error('T3 Code returned an invalid Usage access token.')
      }
      issuedSessionId = parseTokenSessionId(tok.access_token)
      const expiresAt = new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString()
      const record: StoredRpcSession = {
        origin,
        baseDir,
        token: tok.access_token.trim(),
        expiresAt,
        sessionId: issuedSessionId,
      }
      const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, file)
      saved = true
      if (previousSessionId && previousSessionId !== issuedSessionId) {
        await revokeT3Auth(t3Bin, baseDir, 'session', previousSessionId)
      }
      return record
    } finally {
      await revokeT3Auth(t3Bin, baseDir, 'pairing', pairing.id)
      if (!saved) {
        await unlink(tmp).catch(() => {})
        await revokeT3Auth(t3Bin, baseDir, 'session', issuedSessionId)
      }
    }
  })().finally(() => {
    mintingPromise = null
  })
  return mintingPromise
}

export async function revokeUsageSession(): Promise<void> {
  closeUsageClient()
  const file = resolve(rpcSessionFile())
  let parsed: Partial<StoredRpcSession> | null = null
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) return
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredRpcSession>
  } catch {
    return
  }
  const sid = typeof parsed.sessionId === 'string'
    ? parsed.sessionId
    : typeof parsed.token === 'string' ? parseTokenSessionId(parsed.token) : null
  const baseDir = typeof parsed.baseDir === 'string' ? parsed.baseDir : join(homedir(), '.local', 'share', 'devdash-t3')
  await revokeT3Auth(t3Binary(), baseDir, 'session', sid)
  await unlink(file).catch(() => {})
}

async function fetchWsTicket(origin: string, token: string): Promise<{ status: number; ticket?: string }> {
  for (const path of ['/api/auth/websocket-ticket/rpc', '/api/auth/websocket-ticket']) {
    const res = await memberAuthFetch(new URL(path, origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status === 404 && path.endsWith('/rpc')) {
      await res.body?.cancel()
      continue
    }
    if (!res.ok) {
      await res.body?.cancel()
      return { status: res.status }
    }
    const body = await res.json() as { ticket?: unknown }
    return typeof body.ticket === 'string' && body.ticket ? { status: 200, ticket: body.ticket } : { status: 500 }
  }
  return { status: 404 }
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
  return Buffer.concat([header, mask, masked])
}

type PendingCall = {
  kind: 'unary' | 'streamFirst'
  matchChunk?: (value: unknown) => boolean
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let orchestrationProtocol = 2

class T3RpcConnection {
  private socket: Socket
  private recv: Buffer
  private nextId = 1
  private pending = new Map<string, PendingCall>()
  private fragOpcode = 0
  private fragChunks: Buffer[] = []
  private closed = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  readonly origin: string

  constructor(origin: string, socket: Socket, head: Buffer) {
    this.origin = origin
    this.socket = socket
    this.recv = head.length ? Buffer.from(head) : Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))))
    socket.on('close', () => this.failAll(new Error('T3 Code RPC connection closed.')))
    if (this.recv.length) this.drainFrames()
    this.bumpIdle()
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.pending.size > 0 || this.closed) return
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    try { this.socket.write(encodeWsFrame(0x8, Buffer.alloc(0))) } catch { /* ignore */ }
    this.socket.destroy()
    this.failAll(new Error('T3 Code RPC connection closed.'))
  }

  private failAll(err: Error): void {
    this.closed = true
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private sendJson(msg: unknown): void {
    if (!this.isOpen) throw new Error('T3 Code RPC socket is not open.')
    this.socket.write(encodeWsFrame(0x1, Buffer.from(JSON.stringify(msg), 'utf8')))
  }

  call<T = unknown>(tag: string, payload: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    const id = String(this.nextId++)
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        try { this.sendJson({ _tag: 'Interrupt', requestId: id, interruptors: [] }) } catch { /* ignore */ }
        this.bumpIdle()
        reject(new Error(`Timed out waiting for T3 Code ${tag}.`))
      }, timeoutMs)
      this.pending.set(id, { kind: 'unary', resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        this.sendJson({ _tag: 'Request', id, tag, payload, headers: [] })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        this.bumpIdle()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  callStreamFirst<T = unknown>(
    tag: string,
    payload: Record<string, unknown>,
    matchChunk: (v: unknown) => boolean,
    timeoutMs = 15_000,
  ): Promise<T> {
    const id = String(this.nextId++)
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        try { this.sendJson({ _tag: 'Interrupt', requestId: id, interruptors: [] }) } catch { /* ignore */ }
        this.bumpIdle()
        reject(new Error(`Timed out waiting for T3 Code stream ${tag}.`))
      }, timeoutMs)
      this.pending.set(id, { kind: 'streamFirst', matchChunk, resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        this.sendJson({ _tag: 'Request', id, tag, payload, headers: [] })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        this.bumpIdle()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private onData(chunk: Buffer): void {
    this.recv = this.recv.length ? Buffer.concat([this.recv, chunk]) : chunk
    this.drainFrames()
  }

  private drainFrames(): void {
    while (this.recv.length >= 2) {
      const b0 = this.recv[0]!
      const b1 = this.recv[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (this.recv.length < 4) return
        len = this.recv.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.recv.length < 10) return
        len = Number(this.recv.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (this.recv.length < offset + maskLen + len) return
      let body = this.recv.subarray(offset + maskLen, offset + maskLen + len)
      if (masked) {
        const mask = this.recv.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) unmasked[i] = body[i]! ^ mask[i & 3]!
        body = unmasked
      }
      this.recv = this.recv.subarray(offset + maskLen + len)

      if (opcode === 0x8) {
        this.close()
        return
      }
      if (opcode === 0x9) {
        try { this.socket.write(encodeWsFrame(0xA, body)) } catch { /* ignore */ }
        continue
      }
      if (opcode === 0xA) continue

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.handleMessage(body.toString('utf8'))
        } else {
          this.fragOpcode = opcode
          this.fragChunks = [Buffer.from(body)]
        }
      } else if (opcode === 0x0 && this.fragOpcode !== 0) {
        this.fragChunks.push(Buffer.from(body))
        if (fin) {
          const full = Buffer.concat(this.fragChunks).toString('utf8')
          this.fragOpcode = 0
          this.fragChunks = []
          this.handleMessage(full)
        }
      }
    }
  }

  private handleMessage(raw: string): void {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return }
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      const msg = m as Record<string, unknown>
      if (msg._tag === 'Ping') {
        try { this.sendJson({ _tag: 'Pong' }) } catch { /* ignore */ }
        continue
      }
      const reqId = typeof msg.requestId === 'string' ? msg.requestId : null
      if (!reqId) continue
      const pending = this.pending.get(reqId)
      if (!pending) continue

      if (msg._tag === 'Chunk' && Array.isArray(msg.values)) {
        try { this.sendJson({ _tag: 'Ack', requestId: reqId }) } catch { /* ignore */ }
        if (pending.kind === 'streamFirst') {
          const hit = msg.values.find((v) => !pending.matchChunk || pending.matchChunk(v))
          if (hit !== undefined) {
            clearTimeout(pending.timer)
            this.pending.delete(reqId)
            try { this.sendJson({ _tag: 'Interrupt', requestId: reqId, interruptors: [] }) } catch { /* ignore */ }
            this.bumpIdle()
            pending.resolve(hit)
          }
        }
        continue
      }

      if (msg._tag === 'Exit') {
        clearTimeout(pending.timer)
        this.pending.delete(reqId)
        this.bumpIdle()
        const exit = msg.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined
        if (exit?._tag === 'Success') {
          pending.resolve(exit.value)
        } else {
          pending.reject(new Error(extractRpcError(exit?.cause)))
        }
      }
    }
  }
}

function extractRpcError(cause: unknown): string {
  if (!cause || typeof cause !== 'object') return 'T3 Code RPC request failed.'
  const c = cause as Record<string, unknown>
  if (typeof c.message === 'string' && c.message) return c.message
  if (typeof c.detail === 'string' && c.detail) return c.detail
  if (c.error && typeof c.error === 'object') return extractRpcError(c.error)
  if (c.defect && typeof c.defect === 'object') return extractRpcError(c.defect)
  if (Array.isArray(c.failures) && c.failures.length) return extractRpcError(c.failures[0])
  return 'T3 Code RPC request failed.'
}

let sharedConn: T3RpcConnection | null = null
let connectingConn: Promise<T3RpcConnection> | null = null

export function closeUsageClient(): void {
  if (sharedConn) {
    sharedConn.close()
    sharedConn = null
  }
}

async function getRpcConnection(): Promise<T3RpcConnection> {
  const { origin } = memberPaths()
  if (sharedConn && sharedConn.isOpen && sharedConn.origin === origin) return sharedConn
  if (connectingConn) return connectingConn

  connectingConn = (async () => {
    let session = await mintRpcSession(false)
    let ticketRes = await fetchWsTicket(origin, session.token)
    if (ticketRes.status === 401 || ticketRes.status === 403) {
      session = await mintRpcSession(true)
      ticketRes = await fetchWsTicket(origin, session.token)
    }
    if (!ticketRes.ticket) {
      throw new Error(`Could not obtain a T3 Code RPC ticket (HTTP ${ticketRes.status}).`)
    }

    const openWs = async (ticket: string, proto: number) => {
      const wsUrl = new URL('/ws', origin)
      wsUrl.searchParams.set('orchestrationProtocol', String(proto))
      wsUrl.searchParams.set('wsTicket', ticket)
      return memberWsUpgrade(
        wsUrl,
        {
          Origin: origin,
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
        AbortSignal.timeout(10_000),
      )
    }

    let up = await openWs(ticketRes.ticket, orchestrationProtocol)
    if (up.kind === 'http' && up.status === 426) {
      try {
        const body = JSON.parse(up.body) as { orchestrationProtocolVersion?: unknown }
        if (typeof body.orchestrationProtocolVersion === 'number' && Number.isInteger(body.orchestrationProtocolVersion)) {
          orchestrationProtocol = body.orchestrationProtocolVersion
          const nextTicket = await fetchWsTicket(origin, session.token)
          if (nextTicket.ticket) up = await openWs(nextTicket.ticket, orchestrationProtocol)
        }
      } catch { /* fall through */ }
    }
    if (up.kind !== 'upgraded') {
      throw new Error(`T3 Code WebSocket upgrade failed (HTTP ${up.status}).`)
    }
    const conn = new T3RpcConnection(origin, up.socket, up.head)
    sharedConn = conn
    return conn
  })().finally(() => {
    connectingConn = null
  })
  return connectingConn
}

async function withRpc<T>(fn: (conn: T3RpcConnection) => Promise<T>): Promise<T> {
  let conn = await getRpcConnection()
  try {
    return await fn(conn)
  } catch (err) {
    if (!conn.isOpen) {
      sharedConn = null
      conn = await getRpcConnection()
      return fn(conn)
    }
    throw err
  }
}

function normalizeWindow(raw: Record<string, unknown>): T3LimitWindow {
  const used = Math.max(0, Math.min(100, Number(raw.usedPercent) || 0))
  const kind = raw.kind === 'session' || raw.kind === 'weekly' || raw.kind === 'monthly' ? raw.kind : 'other'
  return {
    id: String(raw.id ?? 'window'),
    kind,
    label: String(raw.label ?? 'Limit'),
    usedPercent: used,
    remainingPercent: Math.max(0, Math.min(100, 100 - used)),
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
    windowDurationMins: typeof raw.windowDurationMins === 'number' && raw.windowDurationMins > 0 ? raw.windowDurationMins : null,
  }
}

function normalizeLimits(raw: Record<string, unknown> | undefined) {
  if (!raw) return null
  const windows = Array.isArray(raw.windows)
    ? raw.windows.filter((w): w is Record<string, unknown> => !!w && typeof w === 'object').map(normalizeWindow)
    : []
  const rc = raw.resetCredits as Record<string, unknown> | undefined
  const resetCredits = rc && typeof rc.availableCount === 'number'
    ? {
        availableCount: rc.availableCount,
        nextExpiresAt: typeof rc.nextExpiresAt === 'string' ? rc.nextExpiresAt : null,
        nextCreditId: typeof rc.nextCreditId === 'string' ? rc.nextCreditId : null,
        options: Array.isArray(rc.options)
          ? rc.options
              .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
              .map((o) => ({
                creditId: String(o.creditId ?? ''),
                label: String(o.label ?? 'Reset credit'),
                description: String(o.description ?? ''),
                availableCount: Number(o.availableCount) || 0,
                expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : null,
              }))
          : [],
      }
    : null
  const ext = raw.externalUsage as Record<string, unknown> | undefined
  const externalUsage = ext && typeof ext.label === 'string' && typeof ext.url === 'string'
    ? { label: ext.label, url: ext.url }
    : null
  const unavail = raw.unavailable as Record<string, unknown> | undefined
  const unavailable = unavail && (unavail.reason === 'unsupported' || unavail.reason === 'probeFailed')
    ? { reason: unavail.reason as 'unsupported' | 'probeFailed', message: typeof unavail.message === 'string' ? unavail.message : null }
    : null
  return {
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
    windows,
    zeroSpendCap: raw.zeroSpendCap === true,
    resetCredits,
    externalUsage,
    unavailable,
  }
}

export async function getUsageLimits(opts: { refresh?: boolean } = {}): Promise<T3LimitsResponse> {
  try {
    memberPaths()
  } catch (err) {
    return {
      connected: false,
      checkedAt: new Date().toISOString(),
      accounts: [],
      notices: [],
      error: err instanceof Error ? err.message : 'T3 Code is not connected for your account.',
    }
  }

  return withRpc(async (conn) => {
    if (opts.refresh) {
      await conn.call('server.refreshProviders', { fresh: true }, 25_000).catch(() => {})
    }
    const snap = await conn.callStreamFirst<{ type?: string; config?: Record<string, unknown> }>(
      'subscribeServerConfig',
      { usageLimitSources: true, usageLimitsCommand: true },
      (chunk) => !!chunk && typeof chunk === 'object' && (chunk as { type?: string }).type === 'snapshot',
      15_000,
    )
    const config = snap.config ?? {}
    const providers = Array.isArray(config.providers) ? config.providers as Record<string, unknown>[] : []
    const sources = Array.isArray(config.usageLimitSources) ? config.usageLimitSources as Record<string, unknown>[] : []

    const accounts: T3LimitAccount[] = []
    const notices: string[] = []

    for (const p of providers) {
      if (p.enabled === false) continue
      const instanceId = String(p.instanceId ?? p.driver ?? '')
      const driver = String(p.driver ?? instanceId)
      const displayName = typeof p.displayName === 'string' && p.displayName.trim() ? p.displayName.trim() : null
      const label = displayName ?? driver
      const auth = (p.auth && typeof p.auth === 'object' ? p.auth : {}) as Record<string, unknown>
      const status = String(p.status ?? 'unknown')
      const installed = p.installed === true
      const lim = normalizeLimits(p.usageLimits as Record<string, unknown> | undefined)

      // Skip unconfigured default-enabled providers (e.g. Claude when CLI isn't installed in T3 and not signed in).
      if (!installed && auth.status !== 'authenticated' && (!lim || lim.windows.length === 0)) continue

      if (lim?.unavailable?.reason === 'probeFailed') {
        notices.push(`${label}: ${lim.unavailable.message || 'Could not read rate limits.'}`)
      }
      accounts.push({
        id: `provider:${instanceId}`,
        instanceId,
        driver,
        label,
        displayName,
        accentColor: typeof p.accentColor === 'string' ? p.accentColor : null,
        status,
        plan: typeof auth.label === 'string' ? auth.label : null,
        email: typeof auth.email === 'string' ? auth.email : null,
        sourceLabel: null,
        checkedAt: lim?.checkedAt ?? (typeof p.checkedAt === 'string' ? p.checkedAt : null),
        windows: lim?.windows ?? [],
        zeroSpendCap: lim?.zeroSpendCap ?? false,
        resetCredits: lim?.resetCredits ?? null,
        resetCreditInput: lim?.resetCredits && lim.resetCredits.availableCount > 0 ? { instanceId } : null,
        externalUsage: lim?.externalUsage ?? null,
        unavailable: lim?.unavailable ?? null,
      })
    }

    for (const src of sources) {
      const sourceId = String(src.id ?? 'source')
      const sourceLabel = String(src.label ?? sourceId)
      if (typeof src.error === 'string' && src.error) {
        notices.push(`${sourceLabel}: ${src.error}`)
      }
      const srcAccounts = Array.isArray(src.accounts) ? src.accounts as Record<string, unknown>[] : []
      for (const acc of srcAccounts) {
        const accId = String(acc.id ?? 'account')
        const driver = String(acc.driver ?? 'other')
        const lim = normalizeLimits(acc.usageLimits as Record<string, unknown> | undefined)
        const nextCreditId = lim?.resetCredits?.nextCreditId ?? lim?.resetCredits?.options?.[0]?.creditId
        accounts.push({
          id: `source:${sourceId}:${accId}`,
          instanceId: null,
          driver,
          label: typeof acc.email === 'string' ? acc.email : driver,
          displayName: null,
          accentColor: null,
          status: 'ready',
          plan: typeof acc.plan === 'string' ? acc.plan : null,
          email: typeof acc.email === 'string' ? acc.email : null,
          sourceLabel,
          checkedAt: lim?.checkedAt ?? (typeof src.checkedAt === 'string' ? src.checkedAt : null),
          windows: lim?.windows ?? [],
          zeroSpendCap: lim?.zeroSpendCap ?? false,
          resetCredits: lim?.resetCredits ?? null,
          resetCreditInput: lim?.resetCredits && lim.resetCredits.availableCount > 0 && nextCreditId
            ? { sourceId, accountId: accId, creditId: nextCreditId }
            : null,
          externalUsage: lim?.externalUsage ?? null,
          unavailable: lim?.unavailable ?? null,
        })
      }
      const quotaAccounts = Array.isArray(src.quotaAccounts) ? src.quotaAccounts as Record<string, unknown>[] : []
      for (const qa of quotaAccounts) {
        const qaId = String(qa.id ?? 'quota')
        const windows = Array.isArray(qa.windows)
          ? qa.windows.filter((w): w is Record<string, unknown> => !!w && typeof w === 'object').map(normalizeWindow)
          : []
        accounts.push({
          id: `quota:${sourceId}:${qaId}`,
          instanceId: typeof qa.providerInstanceId === 'string' ? qa.providerInstanceId : null,
          driver: typeof qa.providerInstanceId === 'string' ? qa.providerInstanceId : 'other',
          label: String(qa.label ?? qaId),
          displayName: String(qa.label ?? qaId),
          accentColor: null,
          status: 'ready',
          plan: null,
          email: null,
          sourceLabel,
          checkedAt: typeof src.checkedAt === 'string' ? src.checkedAt : null,
          windows,
          zeroSpendCap: false,
          resetCredits: null,
          resetCreditInput: null,
          externalUsage: null,
          unavailable: null,
        })
      }
    }

    return {
      connected: true,
      checkedAt: new Date().toISOString(),
      accounts,
      notices,
    }
  })
}

export function buildUsageWindowQuery(period: T3UsagePeriod, requestedTz?: string, now = new Date()) {
  let timeZone = requestedTz?.trim() || 'UTC'
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    timeZone = 'UTC'
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
  }
  if (period === 'day') {
    const endMs = Math.floor(now.getTime() / 60_000) * 60_000
    const startMs = endMs - 24 * 3_600_000
    const start = new Date(startMs)
    const end = new Date(endMs)
    return {
      sinceDay: fmt.format(start),
      untilDay: fmt.format(end),
      timeZone,
      resolution: 'hour' as const,
      sinceTime: start.toISOString(),
      untilTime: end.toISOString(),
    }
  }
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 90
  const today = fmt.format(now)
  const [y = 2026, m = 1, d = 1] = today.split('-').map((n) => Number.parseInt(n, 10))
  const startUtc = new Date(Date.UTC(y, m - 1, d - (days - 1)))
  return {
    sinceDay: startUtc.toISOString().slice(0, 10),
    untilDay: today,
    timeZone,
    resolution: 'day' as const,
  }
}

export async function getUsageSummary(opts: {
  period?: T3UsagePeriod
  timeZone?: string
  refresh?: boolean
} = {}): Promise<T3UsageSummaryResponse> {
  const period: T3UsagePeriod = opts.period && ['day', 'week', 'month', 'quarter'].includes(opts.period) ? opts.period : 'month'
  const q = buildUsageWindowQuery(period, opts.timeZone)
  try {
    memberPaths()
  } catch (err) {
    return {
      connected: false,
      period,
      resolution: q.resolution,
      timeZone: q.timeZone,
      sinceDay: q.sinceDay,
      untilDay: q.untilDay,
      ...(q.sinceTime ? { sinceTime: q.sinceTime } : {}),
      ...(q.untilTime ? { untilTime: q.untilTime } : {}),
      readAt: new Date().toISOString(),
      scanDurationMs: 0,
      buckets: [],
      sources: [],
      pricing: { status: 'unavailable', source: '', fetchedAt: null, knownModels: 0 },
      priceOverrides: {},
      modelAliases: {},
      error: err instanceof Error ? err.message : 'T3 Code is not connected for your account.',
    }
  }

  return withRpc(async (conn) => {
    if (opts.refresh) {
      await conn.call('server.refreshUsageRates', {}, 20_000).catch(() => {})
    }
    const [summary, settings] = await Promise.all([
      conn.call<{
        readAt: string
        timeZone: string
        sinceDay: string
        untilDay: string
        buckets: T3UsageBucket[]
        sources: T3UsageSource[]
        pricing: T3PricingCatalog
        scanDurationMs: number
      }>('server.getUsageSummary', { ...q, awaitRefresh: true }, 30_000),
      conn.call<{
        usagePriceOverrides?: Record<string, T3PriceOverride>
        usageModelAliases?: Record<string, string>
      }>('server.getSettings', {}, 15_000).catch(() => ({ usagePriceOverrides: {}, usageModelAliases: {} })),
    ])

    return {
      connected: true,
      period,
      resolution: q.resolution,
      timeZone: summary.timeZone || q.timeZone,
      sinceDay: summary.sinceDay || q.sinceDay,
      untilDay: summary.untilDay || q.untilDay,
      ...(q.sinceTime ? { sinceTime: q.sinceTime } : {}),
      ...(q.untilTime ? { untilTime: q.untilTime } : {}),
      readAt: summary.readAt || new Date().toISOString(),
      scanDurationMs: summary.scanDurationMs ?? 0,
      buckets: Array.isArray(summary.buckets) ? summary.buckets : [],
      sources: Array.isArray(summary.sources) ? summary.sources : [],
      pricing: summary.pricing ?? { status: 'unavailable', source: '', fetchedAt: null, knownModels: 0 },
      priceOverrides: settings.usagePriceOverrides ?? {},
      modelAliases: settings.usageModelAliases ?? {},
    }
  })
}

export async function refreshUsageRates(): Promise<{ pricing: T3PricingCatalog }> {
  return withRpc(async (conn) => {
    const pricing = await conn.call<T3PricingCatalog>('server.refreshUsageRates', {}, 25_000)
    return { pricing }
  })
}

export async function saveUsagePricing(input: {
  priceOverrides?: Record<string, T3PriceOverride | null>
  modelAliases?: Record<string, string | null>
}): Promise<{
  priceOverrides: Record<string, T3PriceOverride>
  modelAliases: Record<string, string>
}> {
  const patch: Record<string, unknown> = {}
  if (input.priceOverrides && Object.keys(input.priceOverrides).length > 0) {
    patch.usagePriceOverrides = input.priceOverrides
  }
  if (input.modelAliases && Object.keys(input.modelAliases).length > 0) {
    patch.usageModelAliases = input.modelAliases
  }
  return withRpc(async (conn) => {
    const updated = Object.keys(patch).length > 0
      ? await conn.call<{ usagePriceOverrides?: Record<string, T3PriceOverride>; usageModelAliases?: Record<string, string> }>(
          'server.updateSettings',
          { patch },
          15_000,
        )
      : await conn.call<{ usagePriceOverrides?: Record<string, T3PriceOverride>; usageModelAliases?: Record<string, string> }>(
          'server.getSettings',
          {},
          15_000,
        )
    return {
      priceOverrides: updated.usagePriceOverrides ?? {},
      modelAliases: updated.usageModelAliases ?? {},
    }
  })
}

export async function consumeResetCredit(input: T3ResetCreditInput): Promise<{
  outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'
  warning?: string
}> {
  return withRpc(async (conn) =>
    conn.call('provider.consumeResetCredit', input as unknown as Record<string, unknown>, 20_000),
  )
}
