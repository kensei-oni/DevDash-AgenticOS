import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../core/db.ts'
import { pcService } from './service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { TailnetService } from '../tailnet/service.ts'
import type { User } from '../auth/repo.ts'

function setup(opts?: { isRole?: (username: string, sessionId: string) => boolean }) {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'ken@example.com', 'ken', 'Ken', 'x', 'x', 'admin')").run()
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (2, 'bob@example.com', 'bob', 'Bob', 'x', 'x', 'member')").run()
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd) values ('sess-personal', 1, 'Personal', '/home/ken')").run()
  const user: User = { id: 1, username: 'ken', name: 'Ken', email: 'ken@example.com', role: 'admin' }
  const masterKey = randomBytes(32)
  const calls: { username: string; msg: Record<string, unknown> }[] = []
  let rpcHandler: ((username: string, params: unknown) => Promise<unknown>) | undefined

  const agents = {
    request: async (username: string, msg: Record<string, unknown>) => {
      calls.push({ username, msg })
      if (msg.op === 'mcps.list') {
        return {
          sources: [{ id: 'codex', label: 'Codex', revision: 'r1', canToggle: true }],
          entries: [],
        }
      }
      if (msg.op === 'mcps.change') return { ok: true }
      if (msg.op === 'pc.request') {
        return { httpStatus: 200, data: { ok: true, targetIp: msg.targetIp, path: msg.path } }
      }
      return { ok: true }
    },
    onRpc: (method: string, fn: (username: string, params: unknown) => Promise<unknown>) => {
      if (method === 'mcp.pc_tool') rpcHandler = fn
    },
  } as unknown as AgentsService

  const tailnet = {
    status: async () => ({
      backendState: 'Running',
      self: { hostName: 'devdash-ken', tailscaleIPs: ['100.111.214.117'] },
      socksPort: 43000,
      httpPort: 43001,
      running: true,
      hasKey: true,
      connected: true,
      devices: [
        { name: 'DESKTOP-LGSA21G', dnsName: 'desktop-lgsa21g.ts.net', os: 'windows', ip: '100.67.118.37', online: true, lastSeen: null },
        { name: "Kensei's A36", dnsName: 'kenseis-a36.ts.net', os: 'android', ip: '100.93.73.0', online: true, lastSeen: null },
      ],
    }),
  } as unknown as TailnetService

  const pc = pcService({ db, agents, tailnet, masterKey, isRole: opts?.isRole })
  pc.registerMcp()
  return { db, user, pc, calls, getRpc: () => rpcHandler! }
}

describe('pcService (Windows PC + Android multi-device + hardening)', () => {
  it('pairs both a Windows PC and Android phone, defaults shell off, and routes MCP tools in personal sessions', async () => {
    const { user, pc, calls, getRpc } = setup()

    await assert.rejects(
      () => pc.pair(user, { name: 'Bad', tailscaleIp: '192.168.1.5' }),
      /Tailscale IPv4/,
    )

    // Default allowShell must be false
    const s1 = await pc.pair(user, { name: 'DESKTOP-LGSA21G', platform: 'windows', tailscaleIp: '100.67.118.37' })
    assert.equal(s1.devices.length, 1)
    assert.equal(s1.devices[0]?.platform, 'windows')
    assert.equal(s1.devices[0]?.allowShell, false)

    const s2 = await pc.pair(user, { name: "Kensei's A36", platform: 'android', tailscaleIp: '100.93.73.0' })
    assert.equal(s2.devices.length, 2)
    const winDev = s2.devices.find((d) => d.platform === 'windows')!
    const andDev = s2.devices.find((d) => d.platform === 'android')!
    assert.equal(andDev.port, 47822)
    assert.equal(andDev.allowShell, false)

    // Shell is blocked by default until explicitly enabled
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_run_powershell', args: { command: 'whoami' }, sessionId: 'sess-personal' }),
      /Shell access is turned off/,
    )

    // Windows installer (.ps1) vs Android Termux installer (.sh)
    const winInst = await pc.installerScript(user, winDev.id)
    assert.match(winInst.filename, /\.ps1$/)
    assert.match(winInst.script, /New-NetFirewallRule/)

    const andInst = await pc.installerScript(user, andDev.id)
    assert.match(andInst.filename, /\.sh$/)
    assert.match(andInst.script, /100\.111\.214\.117/)
    assert.match(andInst.script, /pair-adb\.sh/)

    // MCP pc_list_devices shows both devices in a personal session
    const listed = await getRpc()('ken', { tool: 'pc_list_devices', args: {}, sessionId: 'sess-personal' }) as { devices: unknown[] }
    assert.equal(listed.devices.length, 2)

    // Default targets Windows; device:"android" targets Android phone
    const rWin = await getRpc()('ken', { tool: 'pc_list_windows', args: {}, sessionId: 'sess-personal' }) as Record<string, unknown>
    assert.equal(rWin.targetIp, '100.67.118.37')

    const rAnd = await getRpc()('ken', { tool: 'pc_screenshot', args: { device: 'android' }, sessionId: 'sess-personal' }) as Record<string, unknown>
    assert.equal(rAnd.targetIp, '100.93.73.0')

    // Per-device kill-switch blocks only Android while Windows stays active
    await pc.updateSettings(user, { deviceId: andDev.id, enabled: false })
    await assert.rejects(() => pc.executeTool(user, 'pc_screenshot', { device: 'android' }, 'mcp'), /paused in DevDash/)
    const rWinStillOk = await pc.executeTool(user, 'pc_screenshot', { device: 'windows' }, 'mcp')
    assert.equal(rWinStillOk.ok, true)

    // Global server-side pause blocks ALL devices for MCP calls
    await pc.updateSettings(user, { globalPaused: true })
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_screenshot', args: { device: 'windows' }, sessionId: 'sess-personal' }),
      /Computer Use is paused in DevDash/,
    )
    await pc.updateSettings(user, { globalPaused: false })
    const rAfterResume = await getRpc()('ken', { tool: 'pc_screenshot', args: { device: 'windows' }, sessionId: 'sess-personal' }) as Record<string, unknown>
    assert.equal(rAfterResume.ok, true)

    // One-click MCP install registers my-pc in Codex
    const installed = await pc.installMcp(user)
    assert.equal(installed.results[0]?.ok, true)
    assert.ok(calls.some((c) => c.msg.op === 'mcps.change' && c.msg.name === 'my-pc'))
  })

  it('enforces server-side personal-session-only isolation for MCP calls', async () => {
    const roleIds = new Set(['sess-role'])
    const { db, user, pc, getRpc } = setup({ isRole: (_uid, sid) => roleIds.has(sid) })
    await pc.pair(user, { name: 'DESKTOP', platform: 'windows', tailscaleIp: '100.67.118.37' })

    // Missing sessionId
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_list_devices', args: {} }),
      /personal DevDash Chat session/,
    )

    // Shared session (shared = 1)
    db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared) values ('sess-shared', 1, 'Shared', '/home/ken', 1)").run()
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_list_devices', args: {}, sessionId: 'sess-shared' }),
      /shared sessions/,
    )

    // Viewer-shared session (claude_session_viewers)
    db.prepare("insert into claude_sessions (id, owner_id, title, cwd) values ('sess-viewer', 1, 'Viewer', '/home/ken')").run()
    db.prepare("insert into claude_session_viewers (session_id, user_id) values ('sess-viewer', 2)").run()
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_list_devices', args: {}, sessionId: 'sess-viewer' }),
      /shared sessions/,
    )

    // Hamasa assistant session (origin_kind = 'assistant')
    db.prepare("insert into claude_sessions (id, owner_id, title, cwd, origin_kind) values ('sess-hamasa', 1, 'Hamasa', '/home/ken', 'assistant')").run()
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_list_devices', args: {}, sessionId: 'sess-hamasa' }),
      /role, Hamasa, and background agent/,
    )

    // Role session (isRole callback)
    db.prepare("insert into claude_sessions (id, owner_id, title, cwd) values ('sess-role', 1, 'Role', '/home/ken')").run()
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_list_devices', args: {}, sessionId: 'sess-role' }),
      /role, Hamasa, and background agent/,
    )

    // Teammate turn
    db.prepare("insert into claude_sessions (id, owner_id, title, cwd) values ('sess-guest', 1, 'Guest', '/home/ken')").run()
    db.prepare("insert into claude_message_senders (session_id, message_uuid, user_id) values ('sess-guest', 'msg-1', 2)").run()
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_list_devices', args: {}, sessionId: 'sess-guest' }),
      /teammate turn/,
    )

    // Autopilot turn
    db.prepare("insert into claude_sessions (id, owner_id, title, cwd) values ('sess-auto', 1, 'Auto', '/home/ken')").run()
    db.prepare("insert into claude_message_senders (session_id, message_uuid, user_id) values ('sess-auto', 'msg-auto-1', 1)").run()
    db.prepare("insert into autopilot_sent (uuid, session_id) values ('msg-auto-1', 'sess-auto')").run()
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_list_devices', args: {}, sessionId: 'sess-auto' }),
      /Autopilot turns/,
    )
  })

  it('enforces allowed_folders for pc_fs and uses time-based audit retention', async () => {
    const { db, user, pc, getRpc } = setup()
    const st = await pc.pair(user, { name: 'DESKTOP', platform: 'windows', tailscaleIp: '100.67.118.37' })
    const devId = st.devices[0]!.id

    // Empty allowed_folders blocks all file tools
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_fs', args: { mode: 'list', path: 'C:\\Work' }, sessionId: 'sess-personal' }),
      /No allowed folders/,
    )

    // Configure allowed folder C:\Work
    await pc.updateSettings(user, { deviceId: devId, allowedFolders: ['C:\\Work'] })

    // Inside allowed folder succeeds
    const ok = await getRpc()('ken', { tool: 'pc_fs', args: { mode: 'list', path: 'C:\\Work\\proj' }, sessionId: 'sess-personal' }) as Record<string, unknown>
    assert.equal(ok.ok, true)

    // Outside allowed folder and prefix-spoofed sibling folder fail
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_fs', args: { mode: 'read', path: 'C:\\Users\\ken\\.ssh\\id_ed25519' }, sessionId: 'sess-personal' }),
      /outside the folders/,
    )
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_fs', args: { mode: 'read', path: 'C:\\Work2\\secret.txt' }, sessionId: 'sess-personal' }),
      /outside the folders/,
    )
    // destPath outside allowed folder fails
    await assert.rejects(
      () => getRpc()('ken', { tool: 'pc_fs', args: { mode: 'move', path: 'C:\\Work\\a.txt', destPath: 'C:\\Temp\\a.txt' }, sessionId: 'sess-personal' }),
      /Destination.*outside the folders/,
    )

    // Time-based audit retention keeps >200 recent rows and prunes rows older than 30 days
    const now = Math.floor(Date.now() / 1000)
    const oldTs = now - 31 * 86_400
    db.prepare("insert into pc_audit_log (user_id, device_id, source, action, summary, ok, duration_ms, created_at) values (1, ?, 'mcp', 'pc_status', 'old entry', 1, 5, ?)").run(devId, oldTs)
    const ins = db.prepare("insert into pc_audit_log (user_id, device_id, source, action, summary, ok, duration_ms, created_at) values (1, ?, 'mcp', 'pc_status', 'recent', 1, 5, ?)")
    for (let i = 0; i < 210; i++) ins.run(devId, now - 60)

    await getRpc()('ken', { tool: 'pc_status', args: {}, sessionId: 'sess-personal' })
    const oldCount = (db.prepare("select count(*) as n from pc_audit_log where summary = 'old entry'").get() as { n: number }).n
    const totalCount = (db.prepare('select count(*) as n from pc_audit_log').get() as { n: number }).n
    assert.equal(oldCount, 0)
    assert.ok(totalCount >= 211, `expected >= 211 recent audit rows kept, got ${totalCount}`)
  })

  it('migration 074 preserves pc_audit_log.device_id with PRAGMA foreign_keys = ON inside a transaction', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma foreign_keys = on')
    db.exec(`
      create table users (id integer primary key, username text);
      insert into users (id, username) values (1, 'ken');
    `)
    const migDir = resolve(import.meta.dirname, '../../../migrations')
    const sql73 = readFileSync(resolve(migDir, '073_pc_computer_use.sql'), 'utf8')
    const sql74 = readFileSync(resolve(migDir, '074_pc_multi_device_android.sql'), 'utf8')
    db.exec(sql73)

    db.prepare("insert into pc_devices (id, user_id, name, tailscale_ip, token_sealed) values (7, 1, 'DESKTOP', '100.67.118.37', 'sealed')").run()
    db.prepare("insert into pc_audit_log (user_id, device_id, source, action, summary, ok) values (1, 7, 'mcp', 'pc_status', 'before migration', 1)").run()

    // Execute 074 inside a transaction, exactly as openDb() does
    db.exec('begin')
    try { db.exec(sql74); db.exec('commit') } catch (e) { db.exec('rollback'); throw e }

    const row = db.prepare('select device_id from pc_audit_log where summary = ?').get('before migration') as { device_id: number | null }
    assert.equal(row.device_id, 7)
    const dev = db.prepare('select platform, allow_shell, is_default from pc_devices where id = 7').get() as { platform: string; allow_shell: number; is_default: number }
    assert.equal(dev.platform, 'windows')
    assert.equal(dev.allow_shell, 0)
    assert.equal(dev.is_default, 1)
    db.close()
  })
})
