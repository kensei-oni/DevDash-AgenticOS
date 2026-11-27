// `devdash service ...` for members and their Claude sessions (deploy/devdash-cli routes here).
// Talks to the member's own agent socket, which relays to the DevDash server: no tokens, the socket is the identity.
import { connect } from 'node:net'
import { userInfo } from 'node:os'
import { parseArgs } from 'node:util'

const SOCKET = process.env.DEVDASH_AGENT_SOCKET || `/run/devdash/agent-${userInfo().username}.sock`

const HELP = `Run long-lived things (web servers, APIs, workers, containers) on this server, each on its own port.
DevDash keeps them running after you close everything, and restarts them if they crash.

  devdash service add <name> --cmd '<command>' [--cwd <folder>]   register and start (folder: current one)
        [--env KEY=value ...] [--no-autostart] [--no-restart]     defaults: starts with the server, restarts on crash
  devdash service ls [--mine]                                     every service on the server, everyone's
  devdash service ports                                           every port in use on the server, and by what
  devdash service start|stop|restart|rm <name>
  devdash service logs <name> [-n 200]                            recent output
  devdash service port <name>                                     just the port number

The command must listen on $PORT, bound to 127.0.0.1. Never pick a port yourself.
Docker: docker run --rm -p 127.0.0.1:$PORT:<container-port> ...   Compose: "127.0.0.1:\${PORT}:<port>"`

const DB_HELP = `Each worktree's own copy of the project's dev database (when its main checkout's .env has DEVDASH_WORKTREE_DB=<variable>).

  devdash db          this worktree's own databases (or, in the main checkout, what new worktrees get)
  devdash db reset    copy the main database into this worktree's again, e.g. after main's migrations moved on`

const SUBAGENT_HELP = `Delegate general or specialist tasks to isolated DevDash subagents (works from any session or terminal).

  devdash subagent delegate "<task>" [--role "<name>"] [--instructions "<text>"]
        [--project <slug>] [--cwd <folder>] [--worktree] [--harness claude|opencode|t3code]
        [--model <id>] [--effort <level>] [--bg] [--timeout <sec>] [--json]
  devdash subagent run <slug|general> "<task>" [--project <slug>] [--cwd <folder>] [--worktree] [--bg] [--json]
  devdash subagent batch '<json-tasks-array>' [--bg] [--timeout <sec>] [--json]
  devdash subagent send <runId> "<message>" [--bg] [--timeout <sec>] [--json]
  devdash subagent status [runId] [--wait <sec>] [--json]
  devdash subagent ls [--json]
  devdash subagent stop <runId>`

type Service = { name: string; owner: { username: string }; port: number; state: string; listening: boolean; command: string; cwd: string; session: { title: string } | null }

function call(method: string, params: object = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'rpc', method, params }) + '\n'))
    sock.on('data', (d: string) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      sock.end()
      const m = JSON.parse(buf.slice(0, i)) as { error?: string; result?: Record<string, unknown> }
      if (m.error) reject(new Error(m.error))
      else resolve(m.result ?? {})
    })
    sock.on('error', () => reject(new Error(`Can't reach DevDash (${SOCKET}). This works on the DevDash server, in your own account.`)))
  })
}

const state = (s: Service) => (s.state === 'running' ? (s.listening ? 'running' : 'running, not listening yet') : s.state)


type SubagentCliRun = {
  runId: number
  subagent: string
  name?: string
  project?: string | null
  cwd?: string | null
  status: string
  activity?: string
  stepsCount?: number
  recentSteps?: { label: string; detail?: string }[]
  result?: string | null
  error?: string | null
  note?: string
}

function printSubagentRun(r: SubagentCliRun, asJson?: boolean) {
  if (asJson) return console.log(JSON.stringify(r, null, 2))
  const header = `[run #${r.runId}] ${r.name || r.subagent} · ${r.status}${r.cwd ? ` (${r.cwd})` : ''}`
  console.log(header)
  if (r.error) console.log(`Error: ${r.error}`)
  if (r.result) console.log(`\n${r.result}`)
  else if (r.activity && r.status !== 'completed') console.log(`Activity: ${r.activity}`)
  if (r.recentSteps?.length && r.status !== 'completed') {
    for (const st of r.recentSteps) console.log(`  - ${st.label}${st.detail ? ` (${st.detail})` : ''}`)
  }
  if (r.note) console.log(`Note: ${r.note}`)
}

async function runSubagentCli(cmd: string | undefined, rest: string[]) {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(SUBAGENT_HELP)
    return
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      role: { type: 'string' },
      instructions: { type: 'string' },
      subagent: { type: 'string' },
      session: { type: 'string' },
      project: { type: 'string' },
      cwd: { type: 'string' },
      worktree: { type: 'boolean' },
      harness: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      bg: { type: 'boolean' },
      timeout: { type: 'string' },
      wait: { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const mcpCall = (name: string, args: Record<string, unknown> = {}) =>
    call(`mcp.${name}`, {
      sessionId: values.session || process.env.DEVDASH_SESSION_ID || null,
      cwd: values.cwd ?? process.cwd(),
      args,
    })

  switch (cmd) {
    case 'ls':
    case 'list': {
      const r = await mcpCall('subagents_list') as {
        generalAvailable?: boolean
        defaults?: { harness?: string | null; model?: string | null; effort?: string | null } | null
        subagents?: { slug: string; name: string; scope: string; model: string | null; activeCount: number; description: string }[]
        activeRuns?: { id: number; subagent: string; name?: string; status: string; activity: string; cwd?: string | null }[]
      }
      if (values.json) return console.log(JSON.stringify(r, null, 2))
      const defModel = r.defaults?.model ? `${r.defaults.model}${r.defaults.effort ? ` · ${r.defaults.effort}` : ''}` : 'inherits session default'
      console.log(`General subagent: ${r.generalAvailable === false ? 'unavailable in this session' : `ready (${defModel})`}`)
      if (r.subagents?.length) {
        console.log('\nSaved subagents:')
        for (const s of r.subagents) {
          console.log(`  ${s.slug.padEnd(18)} ${s.name.padEnd(22)} [${s.model || 'default'}] ${s.description}`)
        }
      }
      if (r.activeRuns?.length) {
        console.log('\nActive runs:')
        for (const a of r.activeRuns) {
          console.log(`  #${String(a.id).padEnd(5)} ${(a.name || a.subagent).padEnd(20)} ${a.status.padEnd(9)} ${a.activity}`)
        }
      }
      return
    }
    case 'delegate': {
      const task = positionals.join(' ').trim()
      if (!task) throw new Error('Usage: devdash subagent delegate "<task>" [--role "<name>"] [--worktree] [--bg]')
      const r = await mcpCall('subagent_delegate', {
        task,
        ...(values.role ? { role: values.role } : {}),
        ...(values.instructions ? { instructions: values.instructions } : {}),
        ...(values.subagent ? { subagent: values.subagent } : {}),
        ...(values.project ? { project: values.project } : {}),
        ...(values.cwd ? { folder: values.cwd } : {}),
        ...(values.worktree ? { worktree: true } : {}),
        ...(values.harness ? { harness: values.harness } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.effort ? { effort: values.effort } : {}),
        wait: !values.bg,
        ...(values.timeout ? { timeout_sec: Number(values.timeout) } : {}),
      }) as unknown as SubagentCliRun
      return printSubagentRun(r, values.json)
    }
    case 'run': {
      const [slug, ...taskParts] = positionals
      const task = taskParts.join(' ').trim()
      if (!slug || !task) throw new Error('Usage: devdash subagent run <slug|general> "<task>" [--project <slug>] [--worktree] [--bg]')
      const r = await mcpCall('subagent_run', {
        subagent: slug,
        task,
        ...(values.role ? { role: values.role } : {}),
        ...(values.instructions ? { instructions: values.instructions } : {}),
        ...(values.project ? { project: values.project } : {}),
        ...(values.cwd ? { folder: values.cwd } : {}),
        ...(values.worktree ? { worktree: true } : {}),
        wait: !values.bg,
        ...(values.timeout ? { timeout_sec: Number(values.timeout) } : {}),
      }) as unknown as SubagentCliRun
      return printSubagentRun(r, values.json)
    }
    case 'batch': {
      const rawJson = positionals.join(' ').trim()
      if (!rawJson) throw new Error(`Usage: devdash subagent batch '[{"task":"...","role":"..."}]' [--bg]`)
      let tasks: unknown
      try { tasks = JSON.parse(rawJson) } catch { throw new Error('Invalid JSON tasks array passed to devdash subagent batch.') }
      const r = await mcpCall('subagent_batch', {
        tasks,
        wait: !values.bg,
        ...(values.timeout ? { timeout_sec: Number(values.timeout) } : {}),
      }) as { runs: SubagentCliRun[] }
      if (values.json) return console.log(JSON.stringify(r, null, 2))
      for (const item of r.runs ?? []) {
        printSubagentRun(item, false)
        console.log('---')
      }
      return
    }
    case 'send': {
      const [idRaw, ...msgParts] = positionals
      const message = msgParts.join(' ').trim()
      if (!idRaw || !message) throw new Error('Usage: devdash subagent send <runId> "<follow-up message>" [--bg]')
      const r = await mcpCall('subagent_send', {
        run_id: Number(idRaw),
        message,
        wait: !values.bg,
        ...(values.timeout ? { timeout_sec: Number(values.timeout) } : {}),
      }) as unknown as SubagentCliRun
      return printSubagentRun(r, values.json)
    }
    case 'status': {
      const idRaw = positionals[0]
      const r = await mcpCall('subagent_status', {
        ...(idRaw ? { run_id: Number(idRaw) } : {}),
        ...(values.wait ? { wait_sec: Number(values.wait) } : {}),
      })
      if (values.json) return console.log(JSON.stringify(r, null, 2))
      if (idRaw) return printSubagentRun(r as unknown as SubagentCliRun, false)
      const runs = (r as { runs?: { runId: number; name?: string; subagent: string; status: string; task: string }[] }).runs ?? []
      if (!runs.length) return console.log('No recent subagent runs.')
      for (const item of runs) {
        console.log(`#${String(item.runId).padEnd(5)} ${(item.name || item.subagent).padEnd(20)} ${item.status.padEnd(10)} ${item.task}`)
      }
      return
    }
    case 'stop': {
      const idRaw = positionals[0]
      if (!idRaw) throw new Error('Usage: devdash subagent stop <runId>')
      const r = await mcpCall('subagent_stop', { run_id: Number(idRaw) }) as { runId: number; status: string }
      if (values.json) return console.log(JSON.stringify(r, null, 2))
      return console.log(`Run #${r.runId} ${r.status}.`)
    }
    default:
      throw new Error(`Unknown subagent command: ${cmd}. Try: devdash subagent help`)
  }
}

async function main(argv: string[]) {
  const [group, cmd, ...rest] = argv
  if (group === 'subagent' || group === 'subagents') return runSubagentCli(cmd, rest)
  // `devdash db [reset]`: this worktree's own copy of the dev database (worktree-db.ts), run here as the member.
  if (group === 'db') {
    if (cmd && cmd !== 'reset' && cmd !== 'status') return console.log(DB_HELP)
    const { cli } = await import('./worktree-db.ts')
    return console.log(await cli(process.cwd(), cmd ?? 'status'))
  }
  if (!['service', 'services', 'svc'].includes(group ?? '') || !cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      cmd: { type: 'string' }, cwd: { type: 'string' }, n: { type: 'string', short: 'n' }, env: { type: 'string', multiple: true },
      'no-autostart': { type: 'boolean' }, 'no-restart': { type: 'boolean' }, mine: { type: 'boolean' },
    },
  })
  const name = positionals[0]
  const need = () => {
    if (!name) throw new Error(`Usage: devdash service ${cmd} <name>`)
    return name
  }

  switch (cmd) {
    case 'add': {
      if (!values.cmd) throw new Error("Usage: devdash service add <name> --cmd '<command>' [--cwd <folder>]")
      const r = await call('services.add', {
        name: need(), command: values.cmd, cwd: values.cwd ?? process.cwd(), env: (values.env ?? []).join('\n'),
        autostart: !values['no-autostart'], restart: !values['no-restart'],
        sessionId: process.env.DEVDASH_SESSION_ID, // links it to the Claude session that started it
      })
      const s = r as unknown as Service
      console.log(`${s.name} is starting on port ${s.port} (PORT=${s.port}), in ${s.cwd}.`)
      if ((s as { previewUrl?: string }).previewUrl) console.log(`Open it at ${(s as { previewUrl?: string }).previewUrl}`)
      console.log(`Check it: curl -sI http://127.0.0.1:${s.port}  Logs: devdash service logs ${s.name}`)
      return
    }
    case 'ls':
    case 'list': {
      const all = ((await call('services.list')) as { services: Service[] }).services
      const me = userInfo().username
      const services = values.mine ? all.filter((s) => s.owner.username === me) : all
      if (!services.length) return console.log('No services yet. Add one: devdash service add <name> --cmd "<command>"')
      const rows = [['NAME', 'PORT', 'STATE', 'OWNER', 'COMMAND'], ...services.map((s) => [s.name, String(s.port), state(s), s.owner.username, s.command])]
      const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
      for (const r of rows) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join('  '))
      return
    }
    case 'ports': {
      const { ports } = (await call('services.ports')) as { ports: { port: number; user: string; service: string | null }[] }
      const rows = [['PORT', 'USER', 'WHAT'], ...ports.map((p) => [String(p.port), p.user, p.service ? `service ${p.service}` : 'not a DevDash service'])]
      for (const r of rows) console.log(`${r[0]!.padEnd(6)}  ${r[1]!.padEnd(12)}  ${r[2]}`)
      return console.log('\nDevDash gives services ports 20000-20999 and never one that is already in use.')
    }
    case 'port': {
      const { services } = (await call('services.list')) as { services: Service[] }
      const s = services.find((x) => x.name === need())
      if (!s) throw new Error(`There is no service called ${name}.`)
      return console.log(s.port)
    }
    case 'logs':
      return console.log((await call('services.logs', { name: need(), lines: Number(values.n) || 200 })).text)
    case 'start':
    case 'stop':
    case 'restart': {
      const s = (await call(`services.${cmd}`, { name: need() })) as unknown as Service
      return console.log(cmd === 'stop' ? `${s.name} stopped. It stays stopped until you start it.` : `${s.name} is starting on port ${s.port}.`)
    }
    case 'rm':
    case 'remove':
      await call('services.remove', { name: need() })
      return console.log(`${name} stopped and removed. Port freed.`)
    default:
      throw new Error(`Unknown command: ${cmd}. Try: devdash service help`)
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})
