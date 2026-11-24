export type ParsedMcpServer = {
  name: string
  transport: 'HTTP' | 'stdio'
  url?: string
  command?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

export type KvRow = { id: string; key: string; value: string }

export type McpTemplate = {
  id: string
  label: string
  description: string
  name: string
  transport: 'HTTP' | 'stdio'
  url?: string
  command?: string
  envKeys?: string[]
  headerKeys?: string[]
}

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: 'context7',
    label: 'Context7',
    description: 'Up-to-date docs and code examples for libraries and frameworks.',
    name: 'context7',
    transport: 'HTTP',
    url: 'https://mcp.context7.com/mcp',
  },
  {
    id: 'playwright',
    label: 'Playwright',
    description: 'Headless browser automation and page inspection.',
    name: 'playwright',
    transport: 'stdio',
    command: 'npx -y @playwright/mcp@latest',
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Repositories, pull requests, issues, and code search.',
    name: 'github',
    transport: 'HTTP',
    url: 'https://api.githubcopilot.com/mcp/',
    headerKeys: ['Authorization'],
  },
  {
    id: 'linear',
    label: 'Linear',
    description: 'Issues, cycles, projects, and team workflows.',
    name: 'linear',
    transport: 'HTTP',
    url: 'https://mcp.linear.app/mcp',
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Search, read, and edit Notion pages and databases.',
    name: 'notion',
    transport: 'HTTP',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    id: 'sentry',
    label: 'Sentry',
    description: 'Inspect production errors, stack traces, and releases.',
    name: 'sentry',
    transport: 'HTTP',
    url: 'https://mcp.sentry.dev/mcp',
  },
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning scratchpad.',
    name: 'sequential-thinking',
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-sequential-thinking',
  },
  {
    id: 'filesystem',
    label: 'Filesystem',
    description: 'Scoped local file access for stdio-capable agents.',
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-filesystem /home',
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch web pages and convert HTML to clean markdown.',
    name: 'fetch',
    transport: 'stdio',
    command: 'uvx mcp-server-fetch',
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'Persistent local knowledge graph across sessions.',
    name: 'memory',
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-memory',
  },
]

/** Parse either a JSON string array `["npx", "-y", "pkg"]` or a shell command `npx -y pkg --flag "a b"`. */
export function parseShellCommand(raw: string): string[] | null {
  const s = raw.trim()
  if (!s) return null
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s)
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((v) => typeof v === 'string' && v.length > 0)) {
        return parsed
      }
    } catch {
      return null
    }
    return null
  }
  const args: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < s.length && ['"', '\\', '$', '`'].includes(s[i + 1]!)) cur += s[++i]
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      continue
    }
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i]
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(cur)
        cur = ''
        hasToken = false
      }
      continue
    }
    cur += ch
    hasToken = true
  }
  if (quote) return null
  if (hasToken) args.push(cur)
  return args.length ? args : null
}

/** Format an argv array back into a clean shell command string. */
export function formatShellCommand(args: string[]): string {
  return args
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(' ')
}

export function sanitizeServerName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/^mcp-server-/, '')
    .replace(/-mcp$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-.]+$/g, '')
    .slice(0, 64)
  return cleaned || 'mcp-server'
}

export function inferServerName(input: { url?: string; command?: string[] }): string {
  if (input.url) {
    try {
      const host = new URL(input.url).hostname.replace(/^mcp\./, '').replace(/^api\./, '')
      const first = host.split('.')[0]
      if (first) return sanitizeServerName(first)
    } catch { /* ignore */ }
  }
  if (input.command?.length) {
    const pkg = input.command.find((a, idx) => idx > 0 && !a.startsWith('-') && !a.startsWith('/')) ?? input.command[0]!
    const noVersion = pkg.replace(/@[^@/]+$/, '')
    return sanitizeServerName(noVersion)
  }
  return 'mcp-server'
}

/** Strip JSONC comments and trailing commas outside string literals so pasted snippets parse cleanly. */
function stripJsonc(raw: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    const next = raw[i + 1]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function toStringRecord(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val)
  }
  return Object.keys(out).length ? out : undefined
}

function parseSingleEntry(name: string | null, obj: Record<string, unknown>): ParsedMcpServer | null {
  const urlVal = obj.url ?? obj.serverUrl ?? obj.httpUrl
  if (typeof urlVal === 'string' && urlVal.trim()) {
    const url = urlVal.trim()
    const headers = toStringRecord(obj.headers ?? obj.http_headers)
    return {
      name: name ? sanitizeServerName(name) : inferServerName({ url }),
      transport: 'HTTP',
      url,
      headers,
    }
  }
  let command: string[] | null = null
  if (Array.isArray(obj.command) && obj.command.length && obj.command.every((a) => typeof a === 'string')) {
    command = obj.command as string[]
  } else if (typeof obj.command === 'string' && obj.command.trim()) {
    const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === 'string') : []
    command = args.length ? [obj.command.trim(), ...args] : (parseShellCommand(obj.command) ?? [obj.command.trim()])
  }
  if (command?.length) {
    const env = toStringRecord(obj.env ?? obj.environment)
    return {
      name: name ? sanitizeServerName(name) : inferServerName({ command }),
      transport: 'stdio',
      command,
      env,
    }
  }
  return null
}

/**
 * Parse pasted MCP JSON in any common format:
 * - `{ "mcpServers": { ... } }` (Claude / Cursor / Gemini / Antigravity)
 * - `{ "mcp": { "servers": { ... } } }` or `{ "mcp": { "name": { ... } } }` (OpenCode)
 * - `{ "servers": { ... } }` (VS Code)
 * - `{ "name": { "command" | "url": ... } }` (named map snippet)
 * - `{ "command" | "url": ... }` (single server object)
 */
export function parseMcpJson(raw: string): { servers: ParsedMcpServer[]; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { servers: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(trimmed))
  } catch {
    return { servers: [], error: 'Could not parse JSON. Check quotes, commas, and braces.' }
  }
  if (!isObj(parsed)) {
    return { servers: [], error: 'Paste a JSON object such as { "mcpServers": { ... } } or a single server entry.' }
  }

  let map: Record<string, unknown> | null = null
  if (isObj(parsed.mcpServers)) map = parsed.mcpServers
  else if (isObj(parsed.mcp) && isObj(parsed.mcp.servers)) map = parsed.mcp.servers
  else if (isObj(parsed.mcp)) map = parsed.mcp
  else if (isObj(parsed.mcp_servers)) map = parsed.mcp_servers
  else if (isObj(parsed.servers)) map = parsed.servers

  if (map) {
    const servers: ParsedMcpServer[] = []
    for (const [k, v] of Object.entries(map)) {
      if (!isObj(v)) continue
      const entry = parseSingleEntry(k, v)
      if (entry) servers.push(entry)
    }
    if (!servers.length) return { servers: [], error: 'No valid MCP server definitions found inside that block.' }
    return { servers }
  }

  const direct = parseSingleEntry(typeof parsed.name === 'string' ? parsed.name : null, parsed)
  if (direct) return { servers: [direct] }

  const servers: ParsedMcpServer[] = []
  for (const [k, v] of Object.entries(parsed)) {
    if (!isObj(v)) continue
    const entry = parseSingleEntry(k, v)
    if (entry) servers.push(entry)
  }
  if (servers.length) return { servers }
  return { servers: [], error: 'Could not find a `url` or `command` field in the pasted JSON.' }
}

export function rowsToRecord(rows: KvRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return Object.keys(out).length ? out : undefined
}

export function makeKvRow(key = '', value = ''): KvRow {
  return { id: Math.random().toString(36).slice(2, 10), key, value }
}
