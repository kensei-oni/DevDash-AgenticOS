import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTailscaleIp, parseHttpResponse } from './pc-bridge.ts'

describe('pc-bridge', () => {
  it('accepts only Tailscale CGNAT 100.64.0.0/10 IPv4 addresses', () => {
    assert.equal(isTailscaleIp('100.64.0.1'), true)
    assert.equal(isTailscaleIp('100.67.118.37'), true)
    assert.equal(isTailscaleIp('100.111.214.117'), true)
    assert.equal(isTailscaleIp('100.127.255.254'), true)

    assert.equal(isTailscaleIp('100.63.255.255'), false)
    assert.equal(isTailscaleIp('100.128.0.1'), false)
    assert.equal(isTailscaleIp('127.0.0.1'), false)
    assert.equal(isTailscaleIp('192.168.1.10'), false)
    assert.equal(isTailscaleIp('169.254.169.254'), false)
    assert.equal(isTailscaleIp('8.8.8.8'), false)
    assert.equal(isTailscaleIp('not-an-ip'), false)
  })

  it('parses JSON Content-Length HTTP responses', () => {
    const body = JSON.stringify({ ok: true, hostname: 'DESKTOP-TEST' })
    const raw = Buffer.from(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      'utf8',
    )
    const res = parseHttpResponse(raw)
    assert.equal(res.httpStatus, 200)
    assert.deepEqual(res.data, { ok: true, hostname: 'DESKTOP-TEST' })
  })

  it('parses chunked HTTP responses', () => {
    const body = '{"ok":true,"count":2}'
    const hex = Buffer.byteLength(body).toString(16)
    const raw = Buffer.from(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${hex}\r\n${body}\r\n0\r\n\r\n`,
      'utf8',
    )
    const res = parseHttpResponse(raw)
    assert.equal(res.httpStatus, 200)
    assert.deepEqual(res.data, { ok: true, count: 2 })
  })
})

import { pcRequiresPermission, personalPcMcpEligible } from './claude.ts'

describe('Computer Use agent gates', () => {
  it('requires permission for shell, input, file writes, and clipboard writes across naming styles', () => {
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_run_powershell', { command: 'dir' }), true)
    assert.equal(pcRequiresPermission('my-pc_pc_click', { x: 10, y: 20 }), true)
    assert.equal(pcRequiresPermission('pc_type_text', { text: 'hi' }), true)
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_fs', { mode: 'write', path: 'C:\\Work\\a.txt' }), true)
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_fs', { mode: 'delete', path: 'C:\\Work\\a.txt' }), true)
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_clipboard', { mode: 'set', text: 'abc' }), true)

    // Read-only inspection tools do not require extra confirmation
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_screenshot', {}), false)
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_list_devices', {}), false)
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_fs', { mode: 'list', path: 'C:\\Work' }), false)
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_fs', { mode: 'read', path: 'C:\\Work\\a.txt' }), false)
    assert.equal(pcRequiresPermission('mcp__my-pc__pc_clipboard', { mode: 'get' }), false)
    assert.equal(pcRequiresPermission('Bash', { command: 'ls' }), false)
  })

  it('only injects personal my-pc MCP in unshared, non-role, non-assistant sessions', () => {
    const prev = process.env.DEVDASH_AGENT_SOCKET
    process.env.DEVDASH_AGENT_SOCKET = '/run/devdash/agent-ken.sock'
    try {
      const base = { id: 's1', profile: 'default', cwd: '/home/ken', model: null, effort: null, permissionMode: 'default' as const, started: false }
      assert.equal(personalPcMcpEligible(base), true)
      assert.equal(personalPcMcpEligible({ ...base, shared: true }), false)
      assert.equal(personalPcMcpEligible({ ...base, originKind: 'assistant' }), false)
      assert.equal(personalPcMcpEligible({ ...base, toolPolicy: { tools: ['Read'] } }), false)
    } finally {
      if (prev === undefined) delete process.env.DEVDASH_AGENT_SOCKET
      else process.env.DEVDASH_AGENT_SOCKET = prev
    }
  })
})
