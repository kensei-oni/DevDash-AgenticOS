import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  Cable, Check, ChevronRight, Copy, Eye, EyeOff, FileCode2,
  Plus, RefreshCw, Sparkles, Terminal, Trash2, X,
} from 'lucide-react'
import { confirmAction } from '@/components/app/confirm'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import type { McpEntry, McpInventory, McpSource } from '../../../../agent/src/member-mcps'
import {
  formatShellCommand,
  inferServerName,
  makeKvRow,
  MCP_TEMPLATES,
  parseMcpJson,
  parseShellCommand,
  rowsToRecord,
  type KvRow,
  type McpTemplate,
  type ParsedMcpServer,
} from './mcp-helpers'

const key = ['member-mcps']
const endpoint = api.api.skills.mcps
type Edit = Parameters<typeof endpoint.$post>[0]['json']

const COPY_DRAFT_KEY = 'devdash:mcp-copy-draft'

const rowClass = 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]'

function useMcps() {
  return useQuery({ queryKey: key, queryFn: () => unwrap(endpoint.$get()) })
}

function useMcpEntry(source: string, name: string, reveal: boolean, enabled: boolean) {
  return useQuery({
    queryKey: ['member-mcp-entry', source, name, reveal ? '1' : '0'],
    queryFn: () => unwrap(endpoint.entry.$get({ query: { source, name, reveal: reveal ? '1' : '0' } })),
    enabled,
  })
}

function useMcpSourceConfig(source: string | null, reveal: boolean) {
  return useQuery({
    queryKey: ['member-mcp-source', source, reveal ? '1' : '0'],
    queryFn: () => unwrap(endpoint.source.$get({ query: { source: source!, reveal: reveal ? '1' : '0' } })),
    enabled: !!source,
  })
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

function KvEditor({
  title,
  description,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  onChange,
}: {
  title: string
  description: string
  keyPlaceholder: string
  valuePlaceholder: string
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
}) {
  const [showValues, setShowValues] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-sm font-medium">{title}</span>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {rows.length > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowValues((v) => !v)}>
              {showValues ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {showValues ? 'Hide' : 'Show'}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...rows, makeKvRow()])}>
            <Plus className="size-3.5" />Add
          </Button>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <Input
                value={r.key}
                onChange={(e) => onChange(rows.map((x) => x.id === r.id ? { ...x, key: e.target.value } : x))}
                placeholder={keyPlaceholder}
                className="font-mono text-xs"
              />
              <Input
                type={showValues ? 'text' : 'password'}
                value={r.value}
                onChange={(e) => onChange(rows.map((x) => x.id === r.id ? { ...x, value: e.target.value } : x))}
                placeholder={valuePlaceholder}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Remove row"
                onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConfigCodeBlock({
  text,
  lang,
  hasSecrets,
  revealed,
  onToggleReveal,
  loading,
  extraActions,
}: {
  text: string
  lang: 'json' | 'toml'
  hasSecrets: boolean
  revealed: boolean
  onToggleReveal: () => void
  loading?: boolean
  extraActions?: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono text-[11px] uppercase">{lang}</Badge>
          {hasSecrets && (
            <span className="text-xs text-muted-foreground">
              {revealed ? 'Raw secret values visible' : 'Secret values masked'}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {hasSecrets && (
            <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={onToggleReveal}>
              {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {revealed ? 'Hide secrets' : 'Show secrets'}
            </Button>
          )}
          <CopyButton text={text} />
          {extraActions}
        </div>
      </div>
      <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-foreground">
        <code>{text}</code>
      </pre>
    </div>
  )
}

function SourceConfigDialog({
  source,
  onClose,
}: {
  source: McpSource | null
  onClose: () => void
}) {
  const [reveal, setReveal] = useState(false)
  useEffect(() => { setReveal(false) }, [source?.id])
  const q = useMcpSourceConfig(source?.id ?? null, reveal)

  return (
    <Dialog open={!!source} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{source?.label ?? 'Provider config'}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {q.data?.file ?? source?.file}
          </DialogDescription>
        </DialogHeader>
        <ErrorAlert error={q.error} />
        {q.isPending && <Skeleton className="h-56 rounded-2xl" />}
        {q.data && (
          <ConfigCodeBlock
            text={q.data.configText}
            lang={q.data.configLang}
            hasSecrets={q.data.hasSecrets}
            revealed={q.data.revealed}
            loading={q.isFetching}
            onToggleReveal={() => setReveal((v) => !v)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function McpsPage() {
  const q = useMcps()
  const [search, setSearch] = useState('')
  const [checks, setChecks] = useState<Record<string, string>>({})
  const [viewingSource, setViewingSource] = useState<McpSource | null>(null)
  const check = useMutation({
    mutationFn: (json: Pick<Edit, 'name' | 'source' | 'revision'>) => unwrap(endpoint.check.$post({ json })),
    onSuccess: (result, row) => setChecks((old) => ({ ...old, [[row.source, row.revision, row.name].join('/')]: result.status })),
  })
  const term = search.toLowerCase().trim()
  const totalEntries = q.data?.entries.length ?? 0

  return (
    <>
      <PageHeader title="MCP servers" description="Connections configured for your provider accounts" back="/more" backOnSmall
        actions={(
          <div className="flex items-center gap-2">
            <Button size="sm" asChild>
              <Link to="/mcps/add"><Plus />Add MCP</Link>
            </Button>
            <Button size="sm" variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={cn(q.isFetching && 'animate-spin')} />Refresh
            </Button>
          </div>
        )} />
      <PageBody className="gap-8 py-6 md:py-8">
        <ErrorAlert error={q.error || check.error} />
        {q.isPending && (
          <div className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-13 rounded-xl bg-surface-2" />)}
          </div>
        )}
        {totalEntries > 0 && (
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an MCP server, host, or provider" aria-label="Find an MCP server" />
        )}
        {q.data?.sources.map((source) => {
          const allEntries = q.data.entries.filter((e) => e.source === source.id)
          const entries = term
            ? allEntries.filter((e) => [e.name, e.host ?? '', e.transport, source.label, source.file].join(' ').toLowerCase().includes(term))
            : allEntries
          if (term && !entries.length) return null
          return (
            <section key={source.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold tracking-[-0.01em]">
                    {source.label}
                    {allEntries.length ? <span className="ml-2 font-normal text-muted-foreground tabular-nums">{allEntries.length}</span> : null}
                  </h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">{source.file}</p>
                </div>
                {!source.error && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setViewingSource(source)}>
                      <FileCode2 className="size-3.5" />Config
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/mcps/add/$source" params={{ source: source.id }}><Plus />Add</Link>
                    </Button>
                  </div>
                )}
              </div>
              {source.error && <p className="text-sm text-destructive">{source.error}</p>}
              {!source.error && !entries.length && <p className="text-sm text-muted-foreground">No servers configured.</p>}
              {entries.length > 0 && (
                <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
                  {entries.map((row) => {
                    const status = checks[[source.id, source.revision, row.name].join('/')]
                    return (
                      <li key={row.name} className="flex items-center gap-1">
                        <Link to="/mcps/$source/$name" params={{ source: source.id, name: row.name }} className={cn(rowClass, 'min-w-0 flex-1')}>
                          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"><Cable className="size-4" /></span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className={cn('truncate font-medium', !row.enabled && 'text-muted-foreground')}>{row.name}</span>
                              {!row.enabled && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground">Off</span>}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {row.transport}{row.host ? ` · ${row.host}` : ''}{status ? ` · ${status}` : row.enabled ? ' · Enabled' : ' · Disabled'}
                            </span>
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </Link>
                        {row.enabled && (
                          <Button size="sm" variant="ghost" className="mr-1 shrink-0" disabled={check.isPending}
                            onClick={() => check.mutate({ source: source.id, revision: source.revision, name: row.name })}>
                            Check
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
        {term && q.data && !q.data.entries.some((e) => {
          const src = q.data.sources.find((s) => s.id === e.source)
          return [e.name, e.host ?? '', e.transport, src?.label ?? '', src?.file ?? ''].join(' ').toLowerCase().includes(term)
        }) && <p className="text-sm text-muted-foreground">No matching MCP servers.</p>}
      </PageBody>
      <SourceConfigDialog source={viewingSource} onClose={() => setViewingSource(null)} />
    </>
  )
}

/** Full-page view, config reader & editor for a single MCP server connection. */
export function McpDetailPage() {
  const { source: sourceId, name } = useParams({ strict: false }) as { source: string; name: string }
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useMcps()
  const source: McpSource | undefined = q.data?.sources.find((s) => s.id === sourceId)
  const row: McpEntry | undefined = q.data?.entries.find((e) => e.source === sourceId && e.name === name)

  const [reveal, setReveal] = useState(false)
  const entryQ = useMcpEntry(sourceId, name, reveal, !!source && !!row)

  const [checkStatus, setCheckStatus] = useState<string | null>(null)
  const [transport, setTransport] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [prefilledKey, setPrefilledKey] = useState<string | null>(null)
  const [kvRows, setKvRows] = useState<KvRow[]>([])
  const [invalid, setInvalid] = useState('')

  useEffect(() => {
    const data = entryQ.data
    if (!data) return
    const k = `${data.source}/${data.name}/${data.revision}`
    if (prefilledKey === k) return
    setPrefilledKey(k)
    if (data.url) {
      setTransport('HTTP')
      setValue(data.url)
    } else if (data.command?.length) {
      setTransport('stdio')
      setValue(formatShellCommand(data.command))
    }
  }, [entryQ.data, prefilledKey])

  const activeTransport = transport ?? (row?.transport === 'stdio' ? 'stdio' : 'HTTP')
  const parsedEditCmd = useMemo(() => (activeTransport === 'stdio' ? parseShellCommand(value) : null), [activeTransport, value])

  const check = useMutation({
    mutationFn: (json: Pick<Edit, 'name' | 'source' | 'revision'>) => unwrap(endpoint.check.$post({ json })),
    onSuccess: (result) => setCheckStatus(result.status),
    onError: (err) => toast.error((err as Error).message),
  })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => unwrap(endpoint.$post({
      json: { source: source!.id, revision: source!.revision, name: row!.name, action: 'edit', enabled },
    })),
    onSuccess: async (_r, enabled) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: ['member-mcp-entry', sourceId, name] }),
      ])
      toast.success(enabled ? `${name} is enabled` : `${name} is disabled`)
    },
    onError: (err) => toast.error((err as Error).message),
  })

  const save = useMutation({
    mutationFn: (json: Edit) => unwrap(endpoint.$post({ json })),
    onSuccess: async () => {
      setKvRows([])
      setCheckStatus(null)
      setPrefilledKey(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: ['member-mcp-entry', sourceId, name] }),
      ])
      toast.success(`${name} updated`)
    },
  })

  const remove = useMutation({
    mutationFn: () => unwrap(endpoint.$post({
      json: { source: source!.id, revision: source!.revision, name: row!.name, action: 'remove' },
    })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key })
      toast.success(`${name} removed`)
      void navigate({ to: '/mcps' })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  const askRemove = async () => {
    if (!source || !row) return
    const ok = await confirmAction({
      title: `Remove ${row.name}?`,
      description: `Remove this server from ${source.label}.`,
      action: 'Remove',
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  const copyToOtherProvider = () => {
    const data = entryQ.data
    if (!data) return
    const draft: ParsedMcpServer = {
      name: data.name,
      transport: data.url ? 'HTTP' : 'stdio',
      ...(data.url ? { url: data.url } : {}),
      ...(data.command ? { command: data.command } : {}),
    }
    try {
      sessionStorage.setItem(COPY_DRAFT_KEY, JSON.stringify({ draft, excludeSource: data.source }))
    } catch { /* ignore storage errors */ }
    void navigate({ to: '/mcps/add' })
  }

  const cfg = entryQ.data

  return (
    <>
      <PageHeader title={row?.name ?? name} description={source?.label ?? 'MCP server'} back="/mcps"
        actions={row && source ? (
          <Button variant="ghost" size="sm" className="text-destructive" disabled={remove.isPending} onClick={() => void askRemove()}>
            <Trash2 />Remove
          </Button>
        ) : undefined} />
      <PageBody className="gap-8 py-6 md:py-8">
        <ErrorAlert error={q.error || entryQ.error || check.error} />
        {q.isPending && <Skeleton className="h-44 rounded-2xl" />}
        {q.isSuccess && (!source || !row) && (
          <div className="rounded-2xl bg-surface p-6 text-sm text-muted-foreground">
            This MCP server is no longer configured.
          </div>
        )}
        {source && row && (
          <>
            <header className="flex flex-col gap-4 rounded-2xl bg-surface p-4 md:p-5">
              <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">Provider</dt>
                <dd className="min-w-0 font-medium">{source.label}</dd>
                <dt className="text-muted-foreground">Config file</dt>
                <dd className="min-w-0 break-all font-mono text-[13px] text-muted-foreground">{cfg?.file ?? source.file}</dd>
                <dt className="text-muted-foreground">Transport</dt>
                <dd className="min-w-0">{row.transport}</dd>
                {cfg?.url && (
                  <>
                    <dt className="text-muted-foreground">Endpoint URL</dt>
                    <dd className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all font-mono text-[13px]">{cfg.url}</span>
                      <CopyButton text={cfg.url} />
                    </dd>
                  </>
                )}
                {cfg?.command && (
                  <>
                    <dt className="text-muted-foreground">Command</dt>
                    <dd className="flex min-w-0 flex-wrap items-center gap-2">
                      <code className="min-w-0 break-all rounded-lg bg-surface-2 px-2.5 py-1 font-mono text-[12.5px]">
                        {formatShellCommand(cfg.command)}
                      </code>
                      <CopyButton text={formatShellCommand(cfg.command)} />
                    </dd>
                  </>
                )}
                {cfg?.cwd && (
                  <>
                    <dt className="text-muted-foreground">Working dir</dt>
                    <dd className="min-w-0 break-all font-mono text-[13px]">{cfg.cwd}</dd>
                  </>
                )}
                {cfg && cfg.headerKeys.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">HTTP headers</dt>
                    <dd className="flex flex-wrap gap-1.5">
                      {cfg.headerKeys.map((h) => (
                        <Badge key={h} variant="secondary" className="font-mono text-xs">{h}</Badge>
                      ))}
                    </dd>
                  </>
                )}
                {cfg && cfg.envKeys.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Env vars</dt>
                    <dd className="flex flex-wrap gap-1.5">
                      {cfg.envKeys.map((k) => (
                        <Badge key={k} variant="secondary" className="font-mono text-xs">{k}</Badge>
                      ))}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Status</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span>{checkStatus ?? (row.enabled ? 'Enabled' : 'Disabled')}</span>
                  {row.enabled && (
                    <Button size="sm" variant="outline" disabled={check.isPending || save.isPending}
                      onClick={() => check.mutate({ source: source.id, revision: source.revision, name: row.name })}>
                      {check.isPending ? 'Checking…' : 'Check connection'}
                    </Button>
                  )}
                </dd>
              </dl>
            </header>

            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold tracking-[-0.01em]">Configuration</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Live entry read directly from <span className="font-mono">{cfg?.file ?? source.file}</span>
                  </p>
                </div>
                {cfg && (
                  <Button type="button" size="sm" variant="outline" onClick={copyToOtherProvider}>
                    <Plus className="size-3.5" />Copy to another provider
                  </Button>
                )}
              </div>
              {entryQ.isPending && <Skeleton className="h-36 rounded-2xl" />}
              {cfg && (
                <ConfigCodeBlock
                  text={cfg.configText}
                  lang={cfg.configLang}
                  hasSecrets={cfg.hasSecrets}
                  revealed={cfg.revealed}
                  loading={entryQ.isFetching}
                  onToggleReveal={() => setReveal((v) => !v)}
                />
              )}
            </section>

            {source.canToggle && (
              <label className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Enabled</span>
                  <span className="block text-xs text-pretty text-muted-foreground">
                    Turn off to keep this server in {source.label} without connecting to it.
                  </span>
                </span>
                <Switch checked={row.enabled} disabled={toggle.isPending || save.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
              </label>
            )}

            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-[-0.01em]">Edit connection</h2>
                <p className="mt-0.5 text-sm text-pretty text-muted-foreground">
                  Replacing the endpoint clears previous headers or environment variables unless you specify them below.
                </p>
              </div>
              <form className="flex flex-col gap-4 rounded-2xl bg-surface p-4 md:p-5" onSubmit={(e) => {
                e.preventDefault()
                setInvalid('')
                let command: string[] | null = null
                if (activeTransport === 'stdio') {
                  command = parseShellCommand(value)
                  if (!command) {
                    setInvalid('Enter a command (e.g. npx -y @playwright/mcp@latest) or a JSON string array.')
                    return
                  }
                }
                const extras = rowsToRecord(kvRows)
                save.mutate({
                  source: source.id,
                  revision: source.revision,
                  name: row.name,
                  action: 'edit',
                  ...(command
                    ? { command, ...(extras ? { env: extras } : {}) }
                    : { url: value.trim(), ...(extras ? { headers: extras } : {}) }),
                })
              }}>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="mcp-transport">Transport</label>
                  <NativeSelect id="mcp-transport" value={activeTransport} onChange={(e) => { setTransport(e.target.value); setValue(''); setKvRows([]); setInvalid('') }}>
                    <option value="HTTP">HTTP</option>
                    <option value="stdio">stdio</option>
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="mcp-destination">
                    {activeTransport === 'HTTP' ? 'Server URL' : 'Command (shell command or JSON array)'}
                  </label>
                  <Input id="mcp-destination" required type={activeTransport === 'HTTP' ? 'url' : 'text'}
                    value={value} onChange={(e) => setValue(e.target.value)}
                    className="font-mono text-xs"
                    placeholder={activeTransport === 'HTTP' ? 'https://example.com/mcp' : 'npx -y @upstash/context7-mcp'} />
                  {activeTransport === 'stdio' && parsedEditCmd && (
                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                      Parsed args: {JSON.stringify(parsedEditCmd)}
                    </p>
                  )}
                </div>
                <KvEditor
                  title={activeTransport === 'HTTP' ? 'HTTP headers (optional)' : 'Environment variables (optional)'}
                  description={activeTransport === 'HTTP'
                    ? 'Sent with every request, e.g. Authorization: Bearer ...'
                    : 'Passed to the stdio process, e.g. GITHUB_TOKEN'}
                  keyPlaceholder={activeTransport === 'HTTP' ? 'Authorization' : 'API_KEY'}
                  valuePlaceholder={activeTransport === 'HTTP' ? 'Bearer ...' : 'secret value'}
                  rows={kvRows}
                  onChange={setKvRows}
                />
                {invalid && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
                <ErrorAlert error={save.error} />
                <div>
                  <Button disabled={save.isPending} type="submit">{save.isPending ? 'Saving…' : 'Save connection'}</Button>
                </div>
              </form>
            </section>
          </>
        )}
      </PageBody>
    </>
  )
}

/** Full-page multi-provider MCP adder with Quick, Paste JSON, Templates, and Manual modes. */
export function McpCreatePage() {
  const { source: sourceParam } = useParams({ strict: false }) as { source?: string }
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useMcps()

  const writableSources = useMemo(() => (q.data?.sources ?? []).filter((s) => !s.error), [q.data])

  const [selectedSources, setSelectedSources] = useState<string[]>([])
  const [initializedSources, setInitializedSources] = useState(false)
  const [mode, setMode] = useState<'quick' | 'json' | 'templates' | 'manual'>('quick')

  // Quick mode state
  const [quickInput, setQuickInput] = useState('')
  const [quickName, setQuickName] = useState('')
  const [quickNameTouched, setQuickNameTouched] = useState(false)
  const [quickKv, setQuickKv] = useState<KvRow[]>([])

  // Paste JSON mode state
  const [jsonText, setJsonText] = useState('')
  const [jsonNameOverrides, setJsonNameOverrides] = useState<Record<number, string>>({})

  // Manual mode state
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'HTTP' | 'stdio'>('HTTP')
  const [value, setValue] = useState('')
  const [manualKv, setManualKv] = useState<KvRow[]>([])

  const [invalid, setInvalid] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<Error | null>(null)

  // Hydrate optional "Copy to another provider" draft from McpDetailPage.
  const [excludeSource, setExcludeSource] = useState<string | null>(null)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(COPY_DRAFT_KEY)
      if (!raw) return
      sessionStorage.removeItem(COPY_DRAFT_KEY)
      const parsed = JSON.parse(raw) as { draft?: ParsedMcpServer; excludeSource?: string }
      if (!parsed.draft) return
      const d = parsed.draft
      setExcludeSource(parsed.excludeSource ?? null)
      setMode('manual')
      setName(d.name)
      setTransport(d.transport)
      setValue(d.url ?? (d.command ? formatShellCommand(d.command) : ''))
      toast.info(`Loaded ${d.name} — pick target providers and save`)
    } catch { /* ignore */ }
  }, [])

  // Initialize selected target providers once inventory loads.
  useEffect(() => {
    if (initializedSources || !writableSources.length) return
    setInitializedSources(true)
    if (sourceParam && writableSources.some((s) => s.id === sourceParam)) {
      setSelectedSources([sourceParam])
    } else if (excludeSource) {
      const firstOther = writableSources.find((s) => s.id !== excludeSource)
      if (firstOther) setSelectedSources([firstOther.id])
    } else {
      setSelectedSources([writableSources[0]!.id])
    }
  }, [writableSources, sourceParam, initializedSources, excludeSource])

  // Auto-detect Quick mode input
  const quickParsed = useMemo(() => {
    const trimmed = quickInput.trim()
    if (!trimmed) return null
    if (/^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed)) {
      return { transport: 'HTTP' as const, url: trimmed, suggested: inferServerName({ url: trimmed }) }
    }
    const cmd = parseShellCommand(trimmed)
    if (cmd) {
      return { transport: 'stdio' as const, command: cmd, suggested: inferServerName({ command: cmd }) }
    }
    return null
  }, [quickInput])

  useEffect(() => {
    if (!quickNameTouched && quickParsed) setQuickName(quickParsed.suggested)
  }, [quickParsed, quickNameTouched])

  const jsonParsed = useMemo(() => parseMcpJson(jsonText), [jsonText])
  const manualParsedCmd = useMemo(() => (transport === 'stdio' ? parseShellCommand(value) : null), [transport, value])

  const toggleSource = (id: string) => {
    setSelectedSources((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const applyTemplate = (tpl: McpTemplate) => {
    setName(tpl.name)
    setTransport(tpl.transport)
    setValue(tpl.url ?? tpl.command ?? '')
    const rows: KvRow[] = [
      ...(tpl.headerKeys ?? []).map((k) => makeKvRow(k, k === 'Authorization' ? 'Bearer ' : '')),
      ...(tpl.envKeys ?? []).map((k) => makeKvRow(k, '')),
    ]
    setManualKv(rows)
    setInvalid('')
    setMode('manual')
    toast.info(`Loaded ${tpl.label} template`)
  }

  /** Save one or more normalized servers across all selected providers with fresh revisions. */
  const installServers = async (servers: ParsedMcpServer[]) => {
    setInvalid('')
    setSaveError(null)
    if (!selectedSources.length) {
      setInvalid('Select at least one provider.')
      return
    }
    if (!servers.length) {
      setInvalid('Provide at least one valid MCP server.')
      return
    }
    for (const s of servers) {
      if (!/^[a-zA-Z0-9][\w.-]{0,127}$/.test(s.name)) {
        setInvalid(`Invalid server name "${s.name}". Use letters, numbers, dots, hyphens, or underscores.`)
        return
      }
    }

    setSaving(true)
    try {
      let latest: McpInventory = q.data ?? await unwrap(endpoint.$get())
      const addedLabels: string[] = []
      let lastTarget: { source: string; name: string } | null = null

      for (const sourceId of selectedSources) {
        for (const srv of servers) {
          const src = latest.sources.find((s) => s.id === sourceId)
          if (!src || src.error) throw new Error(`Provider ${sourceId} is unavailable.`)
          const exists = latest.entries.some((e) => e.source === sourceId && e.name === srv.name)
          if (exists) throw new Error(`"${srv.name}" already exists in ${src.label}. Pick a different name or edit it directly.`)

          await unwrap(endpoint.$post({
            json: {
              source: src.id,
              revision: src.revision,
              name: srv.name,
              action: 'create',
              ...(srv.url
                ? { url: srv.url, ...(srv.headers ? { headers: srv.headers } : {}) }
                : { command: srv.command!, ...(srv.env ? { env: srv.env } : {}) }),
            },
          }))
          addedLabels.push(`${srv.name} → ${src.label}`)
          lastTarget = { source: src.id, name: srv.name }
          // Refresh revisions before writing another entry to the same or next provider.
          if (servers.length > 1 || selectedSources.length > 1) {
            latest = await unwrap(endpoint.$get())
          }
        }
      }

      await qc.invalidateQueries({ queryKey: key })
      toast.success(addedLabels.length === 1 ? `Added ${addedLabels[0]}` : `Added ${addedLabels.length} MCP entries`)
      if (addedLabels.length === 1 && lastTarget) {
        void navigate({ to: '/mcps/$source/$name', params: lastTarget })
      } else {
        void navigate({ to: '/mcps' })
      }
    } catch (err) {
      setSaveError(err as Error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Add MCP server"
        description={sourceParam ? writableSources.find((s) => s.id === sourceParam)?.label ?? sourceParam : 'Install into one or more providers at once'}
        back="/mcps"
      />
      <PageBody className="gap-6 py-6 md:py-8">
        <ErrorAlert error={q.error || saveError} />
        {q.isPending && <Skeleton className="h-64 rounded-2xl" />}
        {q.isSuccess && writableSources.length === 0 && (
          <div className="rounded-2xl bg-surface p-6 text-sm text-muted-foreground">
            No writable provider configurations are available.
          </div>
        )}
        {writableSources.length > 0 && (
          <>
            <section className="flex flex-col gap-2.5 rounded-2xl bg-surface p-4 md:p-5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Target providers</h2>
                  <p className="text-xs text-muted-foreground">
                    Choose where to write this MCP configuration ({selectedSources.length} selected)
                  </p>
                </div>
                {writableSources.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedSources(selectedSources.length === writableSources.length ? [writableSources[0]!.id] : writableSources.map((s) => s.id))}
                  >
                    {selectedSources.length === writableSources.length ? 'Select one' : 'Select all'}
                  </Button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {writableSources.map((src) => {
                  const checked = selectedSources.includes(src.id)
                  return (
                    <label
                      key={src.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition-colors',
                        checked ? 'border-foreground/30 bg-surface-2' : 'border-border/60 hover:bg-surface-2/60',
                      )}
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleSource(src.id)} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{src.label}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{src.file}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </section>

            <Tabs value={mode} onValueChange={(v) => { setMode(v as typeof mode); setInvalid(''); setSaveError(null) }}>
              <TabsList className="w-full justify-start overflow-x-auto">
                <TabsTrigger value="quick"><Terminal className="size-3.5" />Quick command / URL</TabsTrigger>
                <TabsTrigger value="json"><FileCode2 className="size-3.5" />Paste JSON</TabsTrigger>
                <TabsTrigger value="templates"><Sparkles className="size-3.5" />Templates</TabsTrigger>
                <TabsTrigger value="manual">Manual</TabsTrigger>
              </TabsList>

              <TabsContent value="quick" className="mt-4">
                <form
                  className="flex flex-col gap-4 rounded-2xl bg-surface p-4 md:p-5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (!quickParsed) {
                      setInvalid('Paste an https:// MCP URL or a command like npx -y @upstash/context7-mcp')
                      return
                    }
                    const extras = rowsToRecord(quickKv)
                    void installServers([{
                      name: quickName.trim() || quickParsed.suggested,
                      transport: quickParsed.transport,
                      ...(quickParsed.transport === 'HTTP'
                        ? { url: quickParsed.url, ...(extras ? { headers: extras } : {}) }
                        : { command: quickParsed.command, ...(extras ? { env: extras } : {}) }),
                    }])
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="mcp-quick-input">Command or URL</label>
                    <Input
                      id="mcp-quick-input"
                      required
                      value={quickInput}
                      onChange={(e) => setQuickInput(e.target.value)}
                      className="font-mono text-xs"
                      placeholder="https://mcp.context7.com/mcp  or  npx -y @playwright/mcp@latest"
                    />
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {quickParsed ? (
                        <>
                          <Badge variant="secondary">{quickParsed.transport}</Badge>
                          {quickParsed.transport === 'stdio' && (
                            <span className="truncate font-mono text-[11px]">{JSON.stringify(quickParsed.command)}</span>
                          )}
                          {quickParsed.transport === 'HTTP' && (
                            <span>Remote HTTP/Streamable MCP endpoint</span>
                          )}
                        </>
                      ) : (
                        <span>Paste any MCP URL or shell command — transport and args are detected automatically.</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="mcp-quick-name">Server name</label>
                    <Input
                      id="mcp-quick-name"
                      required
                      value={quickName}
                      onChange={(e) => { setQuickName(e.target.value); setQuickNameTouched(true) }}
                      placeholder="context7"
                    />
                  </div>
                  <KvEditor
                    title={quickParsed?.transport === 'stdio' ? 'Environment variables (optional)' : 'HTTP headers (optional)'}
                    description={quickParsed?.transport === 'stdio'
                      ? 'Add API keys or env vars required by this command.'
                      : 'Add auth headers if required, e.g. Authorization: Bearer ...'}
                    keyPlaceholder={quickParsed?.transport === 'stdio' ? 'API_KEY' : 'Authorization'}
                    valuePlaceholder={quickParsed?.transport === 'stdio' ? 'secret value' : 'Bearer ...'}
                    rows={quickKv}
                    onChange={setQuickKv}
                  />
                  {invalid && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
                  <div>
                    <Button disabled={saving || !selectedSources.length} type="submit">
                      {saving ? 'Adding…' : `Add to ${selectedSources.length} ${selectedSources.length === 1 ? 'provider' : 'providers'}`}
                    </Button>
                  </div>
                </form>
              </TabsContent>

              <TabsContent value="json" className="mt-4">
                <form
                  className="flex flex-col gap-4 rounded-2xl bg-surface p-4 md:p-5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (jsonParsed.error || !jsonParsed.servers.length) {
                      setInvalid(jsonParsed.error ?? 'Paste a valid MCP JSON snippet.')
                      return
                    }
                    const servers = jsonParsed.servers.map((s, idx) => ({
                      ...s,
                      name: (jsonNameOverrides[idx] ?? s.name).trim(),
                    }))
                    void installServers(servers)
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="mcp-json-input">MCP config snippet (JSON / JSONC)</label>
                    <p className="text-xs text-muted-foreground">
                      Paste directly from any docs or README — supports Claude/Cursor <code className="font-mono">mcpServers</code>, OpenCode <code className="font-mono">mcp.servers</code>, VS Code <code className="font-mono">servers</code>, or a single server object. Converted automatically to each selected provider&apos;s native format (including Codex TOML).
                    </p>
                    <Textarea
                      id="mcp-json-input"
                      rows={8}
                      value={jsonText}
                      onChange={(e) => { setJsonText(e.target.value); setJsonNameOverrides({}); setInvalid('') }}
                      className="font-mono text-xs"
                      placeholder={`{\n  "mcpServers": {\n    "playwright": {\n      "command": "npx",\n      "args": ["-y", "@playwright/mcp@latest"]\n    }\n  }\n}`}
                    />
                  </div>

                  {jsonParsed.error && (
                    <p role="alert" className="text-sm text-destructive">{jsonParsed.error}</p>
                  )}

                  {jsonParsed.servers.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Detected {jsonParsed.servers.length} {jsonParsed.servers.length === 1 ? 'server' : 'servers'}
                      </span>
                      {jsonParsed.servers.map((srv, idx) => (
                        <div key={idx} className="flex flex-col gap-2 rounded-xl border border-border/60 bg-background/40 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              value={jsonNameOverrides[idx] ?? srv.name}
                              onChange={(e) => setJsonNameOverrides((old) => ({ ...old, [idx]: e.target.value }))}
                              aria-label="Server name"
                              className="h-8 max-w-52 font-mono text-xs"
                            />
                            <Badge variant="secondary">{srv.transport}</Badge>
                            {srv.env && <Badge variant="outline">{Object.keys(srv.env).length} env</Badge>}
                            {srv.headers && <Badge variant="outline">{Object.keys(srv.headers).length} headers</Badge>}
                          </div>
                          <p className="break-all font-mono text-[11.5px] text-muted-foreground">
                            {srv.url ?? (srv.command ? formatShellCommand(srv.command) : '')}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {invalid && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
                  <div>
                    <Button disabled={saving || !selectedSources.length || !jsonParsed.servers.length} type="submit">
                      {saving
                        ? 'Importing…'
                        : `Import ${jsonParsed.servers.length || 1} ${jsonParsed.servers.length === 1 ? 'server' : 'servers'} to ${selectedSources.length} ${selectedSources.length === 1 ? 'provider' : 'providers'}`}
                    </Button>
                  </div>
                </form>
              </TabsContent>

              <TabsContent value="templates" className="mt-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {MCP_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => applyTemplate(tpl)}
                      className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-surface p-4 text-left transition-colors hover:border-foreground/30 hover:bg-surface-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{tpl.label}</span>
                        <Badge variant="secondary" className="text-[11px]">{tpl.transport}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{tpl.description}</p>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {tpl.url ?? tpl.command}
                      </span>
                    </button>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="manual" className="mt-4">
                <form
                  className="flex flex-col gap-4 rounded-2xl bg-surface p-4 md:p-5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    let command: string[] | null = null
                    if (transport === 'stdio') {
                      command = parseShellCommand(value)
                      if (!command) {
                        setInvalid('Enter a command (e.g. npx -y @playwright/mcp@latest) or a JSON string array.')
                        return
                      }
                    }
                    const extras = rowsToRecord(manualKv)
                    void installServers([{
                      name: name.trim(),
                      transport,
                      ...(command
                        ? { command, ...(extras ? { env: extras } : {}) }
                        : { url: value.trim(), ...(extras ? { headers: extras } : {}) }),
                    }])
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="mcp-new-name">Server name</label>
                    <Input id="mcp-new-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="mcp-new-transport">Transport</label>
                    <NativeSelect id="mcp-new-transport" value={transport} onChange={(e) => { setTransport(e.target.value as 'HTTP' | 'stdio'); setValue(''); setManualKv([]); setInvalid('') }}>
                      <option value="HTTP">HTTP</option>
                      <option value="stdio">stdio</option>
                    </NativeSelect>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="mcp-new-destination">
                      {transport === 'HTTP' ? 'Server URL' : 'Command (shell command or JSON array)'}
                    </label>
                    <Input id="mcp-new-destination" required type={transport === 'HTTP' ? 'url' : 'text'}
                      value={value} onChange={(e) => setValue(e.target.value)}
                      className="font-mono text-xs"
                      placeholder={transport === 'HTTP' ? 'https://example.com/mcp' : 'npx -y @upstash/context7-mcp'} />
                    {transport === 'stdio' && manualParsedCmd && (
                      <p className="break-all font-mono text-[11px] text-muted-foreground">
                        Parsed args: {JSON.stringify(manualParsedCmd)}
                      </p>
                    )}
                  </div>
                  <KvEditor
                    title={transport === 'HTTP' ? 'HTTP headers (optional)' : 'Environment variables (optional)'}
                    description={transport === 'HTTP'
                      ? 'Sent with every request, e.g. Authorization: Bearer ...'
                      : 'Passed to the stdio process, e.g. GITHUB_TOKEN'}
                    keyPlaceholder={transport === 'HTTP' ? 'Authorization' : 'API_KEY'}
                    valuePlaceholder={transport === 'HTTP' ? 'Bearer ...' : 'secret value'}
                    rows={manualKv}
                    onChange={setManualKv}
                  />
                  {invalid && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
                  <div>
                    <Button disabled={saving || !selectedSources.length} type="submit">
                      {saving ? 'Saving…' : `Save to ${selectedSources.length} ${selectedSources.length === 1 ? 'provider' : 'providers'}`}
                    </Button>
                  </div>
                </form>
              </TabsContent>
            </Tabs>
          </>
        )}
      </PageBody>
    </>
  )
}
