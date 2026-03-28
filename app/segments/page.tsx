'use client'
// Why client component: the segment builder is highly interactive — live contact count
// preview as the user types (debounced), instant delete, and a save action.
// These require local state and event handlers that don't work in RSCs.
// SWR-style state management lets us show optimistic updates on segment creation.

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Trash2, ChevronDown, ChevronRight, Users, Sparkles, RefreshCw, Download, Copy, Check } from 'lucide-react'

type Segment = {
  id: string
  label: string
  description: string
  filter_sql: string
  contact_count: number
  created_at: string
}

type SegmentContact = {
  id: string
  name: string | null
  email: string
  given_email: string | null
  company: string | null
  role: string | null
  linkedin_url: string | null
  phone: string | null
}

type PreviewResult = {
  label: string
  description: string
  filter_sql: string
  contact_count: number
  // sample: a small set of matching contacts shown in preview so the user
  // can sanity-check "is this actually the right people?" before saving.
  sample?: { name: string | null; email: string; role: string | null }[]
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

// CopyButton: tiny self-contained copy button with a 2s "Copied" flash.
// Why its own component not inline state: it appears once per contact row in a
// list. Lifting copied state into SegmentCard would require a Map<contactId, bool>
// and re-render the whole list on every copy. Local state keeps the flash isolated
// to the button that was clicked.
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleCopy() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-0.5 text-xs text-gray-400 hover:text-gray-700 transition-colors shrink-0"
      title={`Copy ${label}`}
    >
      {copied
        ? <Check className="w-3 h-3 text-green-500" />
        : <Copy className="w-3 h-3" />}
    </button>
  )
}

// Downloads a string as a file in the browser.
// Why not a server route: we already have the data client-side from the contacts
// fetch. Generating the CSV in the browser avoids a second round-trip and keeps
// the download instant after the contacts are loaded.
function downloadCSV(contacts: SegmentContact[], label: string) {
  const headers = ['name', 'email', 'given_email', 'company', 'role', 'linkedin_url', 'phone']
  const rows = contacts.map(c => [
    c.name ?? '',
    c.email,
    c.given_email ?? '',
    c.company ?? '',
    c.role ?? '',
    c.linkedin_url ?? '',
    c.phone ?? '',
  ].map(v => `"${v.replace(/"/g, '""')}"`).join(','))

  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${label.toLowerCase().replace(/\s+/g, '-')}-contacts.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// SegmentCard renders a single saved segment with contact list, export, and copy.
// Why separate component: each card has its own async state (contacts loaded lazily,
// copy confirmation timer, refresh in-flight). Keeping this state local avoids
// polluting the parent with per-card transient state.
function SegmentCard({
  segment,
  onDelete,
  onCountUpdated,
}: {
  segment: Segment
  onDelete: (id: string) => void
  onCountUpdated: (id: string, newCount: number) => void
}) {
  const [sqlOpen, setSqlOpen] = useState(false)
  const [contactsOpen, setContactsOpen] = useState(false)
  const [contacts, setContacts] = useState<SegmentContact[] | null>(null)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsCapped, setContactsCapped] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [count, setCount] = useState(segment.contact_count)
  // emailSep: comma-separated vs one-per-line for copy
  // Why toggle not fixed format: different tools expect different formats —
  // Mailchimp wants comma-separated, Notion/Slack paste works better line-by-line.
  const [emailSep, setEmailSep] = useState<'comma' | 'line' | 'custom'>('comma')
  const [customSep, setCustomSep] = useState('')

  // Sanitize a user-supplied separator before it touches clipboard output.
  // Risks addressed:
  // 1. CSV/spreadsheet formula injection — Excel/Sheets execute cells starting
  //    with =, +, -, @ as formulas when pasted. Strip leading formula chars.
  // 2. Control characters (\x00–\x1F except \t and space) — can cause silent
  //    truncation or encoding issues in downstream tools (Mailchimp, Notion, etc.)
  // 3. Length — no reason to allow more than 10 chars; caps accidental pastes.
  function sanitizeSeparator(raw: string): string {
    return raw
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip control chars (keep \t \n \r space)
      .replace(/^[=+\-@|`]+/, '')                          // strip leading formula-injection chars
      .slice(0, 10)                                         // max 10 chars
  }
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Lazily fetch contacts when the panel is first expanded.
  // Why lazy: most segment cards are viewed for their count/description without
  // drilling in. Fetching all contacts on mount would waste bandwidth for every
  // segment the user has saved.
  async function handleToggleContacts() {
    if (!contactsOpen && contacts === null) {
      setContactsLoading(true)
      try {
        const res = await fetch(`/api/segments/${segment.id}/contacts`)
        if (res.ok) {
          const data = await res.json()
          setContacts(data.contacts)
          setContactsCapped(data.capped)
        }
      } finally {
        setContactsLoading(false)
      }
    }
    setContactsOpen(o => !o)
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/segments/${segment.id}/refresh`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setCount(data.contact_count)
        onCountUpdated(segment.id, data.contact_count)
        // Invalidate cached contacts so the list reloads on next expand
        setContacts(null)
      }
    } finally {
      setRefreshing(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete segment "${segment.label}"?`)) return
    setDeleting(true)
    await fetch(`/api/segments?id=${segment.id}`, { method: 'DELETE' })
    onDelete(segment.id)
  }

  function handleCopyEmails() {
    if (!contacts) return
    // Use given_email (preferred outreach address) when available, fall back to account email.
    // Why prefer given_email: it's the address the contact typed in the registration form —
    // often their preferred contact address vs. their Luma account email.
    const emails = contacts.map(c => c.given_email || c.email)
    const separator = emailSep === 'comma' ? ', ' : emailSep === 'line' ? '\n' : sanitizeSeparator(customSep)
    const text = emails.join(separator)
    navigator.clipboard.writeText(text)
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="border rounded-lg bg-white hover:border-gray-300 transition-colors">
      {/* Card header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-medium text-sm text-gray-900 truncate">{segment.label}</span>
              {/* Contact count badge — updates live after refresh */}
              <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded shrink-0">
                <Users className="w-3 h-3" />
                {count.toLocaleString()}
              </span>
            </div>
            <p className="text-sm text-gray-500 leading-snug">{segment.description}</p>
            <p className="text-xs text-gray-400 mt-1.5">{relativeTime(segment.created_at)}</p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* Refresh count */}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-1.5 text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-50"
              aria-label="Refresh contact count"
              title="Refresh count"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            {/* Delete */}
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-1.5 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
              aria-label={`Delete ${segment.label}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Action row */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {/* View contacts toggle */}
          <button
            onClick={handleToggleContacts}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded px-2 py-1 transition-colors"
          >
            {contactsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {contactsLoading ? 'Loading…' : contactsOpen ? 'Hide contacts' : 'View contacts'}
          </button>

          {/* SQL toggle */}
          <button
            onClick={() => setSqlOpen(o => !o)}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded px-2 py-1 transition-colors"
          >
            {sqlOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            SQL
          </button>
        </div>

        {sqlOpen && (
          <pre className="mt-2 p-2.5 bg-gray-50 rounded text-xs text-gray-600 overflow-x-auto whitespace-pre-wrap break-all font-mono">
            {segment.filter_sql}
          </pre>
        )}
      </div>

      {/* Contacts panel — lazy loaded on first expand */}
      {contactsOpen && (
        <div className="border-t">
          {contactsLoading ? (
            <div className="px-4 py-3 text-xs text-gray-400 animate-pulse">Loading contacts…</div>
          ) : contacts && contacts.length > 0 ? (
            <>
              {/* Export / copy toolbar */}
              <div className="px-4 py-2.5 border-b bg-gray-50 flex items-center gap-3 flex-wrap">
                {/* Export CSV — standalone action, visually separated by gap+divider */}
                <button
                  onClick={() => downloadCSV(contacts, segment.label)}
                  className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 border border-gray-200 bg-white rounded px-2.5 py-1 transition-colors"
                >
                  <Download className="w-3 h-3" />
                  Export CSV
                </button>

                {/* Divider — visually separates export from the copy+separator group */}
                <div className="w-px h-4 bg-gray-200 shrink-0" />

                {/* Copy emails + Separator: grouped tightly so it's clear they belong together */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleCopyEmails}
                    className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 border border-gray-200 bg-white rounded px-2.5 py-1 transition-colors"
                  >
                    {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied!' : 'Copy emails'}
                  </button>

                  {/* Separator label + toggles — adjacent to copy button, no gap */}
                  <div className="flex items-center gap-0 border border-gray-200 rounded overflow-hidden">
                    <span className="text-xs text-gray-400 px-2 py-1 bg-gray-50 border-r border-gray-200 select-none">
                      Separator
                    </span>
                    <button
                      onClick={() => setEmailSep('comma')}
                      className={`text-xs px-2.5 py-1 transition-colors ${emailSep === 'comma' ? 'bg-gray-100 text-gray-900 font-medium' : 'bg-white text-gray-400 hover:text-gray-700'}`}
                      title="Comma-separated"
                    >
                      ,
                    </button>
                    <button
                      onClick={() => setEmailSep('line')}
                      className={`text-xs px-2.5 py-1 border-l border-gray-200 transition-colors ${emailSep === 'line' ? 'bg-gray-100 text-gray-900 font-medium' : 'bg-white text-gray-400 hover:text-gray-700'}`}
                      title="One per line"
                    >
                      ↵
                    </button>
                    {/* Custom separator input */}
                    <div className={`border-l border-gray-200 flex items-center transition-colors ${emailSep === 'custom' ? 'bg-gray-100' : 'bg-white'}`}>
                      <input
                        type="text"
                        value={customSep}
                        placeholder="custom"
                        onFocus={() => setEmailSep('custom')}
                        onChange={e => { setCustomSep(sanitizeSeparator(e.target.value)); setEmailSep('custom') }}
                        className="w-14 text-xs px-2 py-1 bg-transparent outline-none text-gray-700 placeholder-gray-300"
                        title="Custom separator"
                      />
                    </div>
                  </div>
                </div>

                <span className="text-xs text-gray-400 ml-auto">
                  {contactsCapped ? `2,000+ contacts (capped)` : `${contacts.length.toLocaleString()} contacts`}
                </span>
              </div>

              {/* Contact list */}
              <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                {contacts.map(c => (
                  <div key={c.id} className="px-4 py-2 flex items-center gap-3 text-sm hover:bg-gray-50">
                    {/* Name + role */}
                    <div className="w-44 min-w-0 shrink-0">
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-gray-900 truncate">{c.name ?? <span className="text-gray-400 font-normal">—</span>}</span>
                        {c.name && <CopyButton text={c.name} label="name" />}
                      </div>
                      {c.role && <div className="text-gray-400 text-xs truncate">{c.role}</div>}
                    </div>
                    {/* Email */}
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <span className="text-gray-500 text-xs truncate">{c.given_email || c.email}</span>
                      <CopyButton text={c.given_email || c.email} label="email" />
                    </div>
                    {/* Phone — shown only when present */}
                    {c.phone && (
                      <span className="text-gray-400 text-xs shrink-0">{c.phone}</span>
                    )}
                    {/* LinkedIn — open link + copy URL side by side */}
                    {c.linkedin_url && (
                      <div className="flex items-center gap-1 shrink-0">
                        <a
                          href={c.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:text-blue-700 truncate max-w-24"
                          title={c.linkedin_url}
                        >
                          LinkedIn ↗
                        </a>
                        <CopyButton text={c.linkedin_url} label="LinkedIn URL" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="px-4 py-3 text-xs text-gray-400">No contacts match this segment.</div>
          )}
        </div>
      )}
    </div>
  )
}

// Example segment queries surfaced as quick-pick chips.
// Why curate these: cold-start problem — users stare at an empty textarea.
// Showing real examples teaches the syntax and sparks ideas simultaneously.
// These map to the NL_SEARCH_PROMPT examples so they're known to work.
const EXAMPLE_QUERIES = [
  'Founders who attended 3+ events',
  'Contacts who used a coupon code',
  'People who paid for a ticket',
  'Investors or VCs in my network',
  'Non-founders with a LinkedIn URL',
  'Engineers interested in AI',
  'People from San Francisco',
  'Founders at Series A stage',
  'Contacts who attended every event',
  'Bootstrapped founders',
]

export default function SegmentsPage() {
  const [description, setDescription] = useState('')
  const [segments, setSegments] = useState<Segment[]>([])
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loadingSegments, setLoadingSegments] = useState(true)

  // Why useRef for debounce: storing the timer in a ref avoids triggering re-renders
  // when the timer is set/cleared. A state variable would cause unnecessary renders
  // on every keystroke before the debounce fires.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load saved segments on mount
  const loadSegments = useCallback(async () => {
    setLoadingSegments(true)
    try {
      const res = await fetch('/api/segments')
      if (res.ok) {
        const data = await res.json()
        setSegments(data.segments ?? [])
      }
    } finally {
      setLoadingSegments(false)
    }
  }, [])

  useEffect(() => {
    loadSegments()
  }, [loadSegments])

  // Live preview — debounced 600ms after last keystroke.
  // Why 600ms not 300ms: segment generation calls Claude (~1-2s) — a shorter
  // debounce would fire multiple in-flight requests per typing session, wasting
  // tokens and causing race conditions where an earlier response overwrites a later one.
  const fetchPreview = useCallback(async (desc: string) => {
    if (!desc.trim()) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const res = await fetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc, preview: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPreviewError(data.error ?? 'Could not generate preview')
        setPreview(null)
      } else {
        setPreview(data)
      }
    } catch {
      setPreviewError('Network error — check your connection')
      setPreview(null)
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setDescription(val)
    setSaveError(null)

    // Clear any pending debounce timer before starting a new one
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchPreview(val), 600)
  }

  // Clicking an example chip populates the textarea and immediately triggers preview.
  // Why immediate trigger (0ms debounce): the user explicitly chose this query —
  // no need to wait 600ms. Instant feedback makes chip selection feel snappy.
  function handleExampleClick(example: string) {
    setDescription(example)
    setSaveError(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchPreview(example), 0)
  }

  async function handleSave() {
    if (!description.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, preview: false }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSaveError(data.error ?? 'Failed to save segment')
      } else {
        // Prepend the new segment so it appears at the top of the list
        setSegments(prev => [data.segment, ...prev])
        setDescription('')
        setPreview(null)
      }
    } catch {
      setSaveError('Network error — check your connection')
    } finally {
      setSaving(false)
    }
  }

  function handleDelete(id: string) {
    setSegments(prev => prev.filter(s => s.id !== id))
  }

  function handleCountUpdated(id: string, newCount: number) {
    setSegments(prev => prev.map(s => s.id === id ? { ...s, contact_count: newCount } : s))
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 py-4 border-b">
        <h1 className="text-sm font-semibold">Segments</h1>
        <p className="text-xs text-gray-400 mt-0.5">Build audiences with plain English</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {/* Segment builder input */}
          <div className="border rounded-lg p-4 bg-white space-y-3">
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Describe your audience
            </label>
            <textarea
              value={description}
              onChange={handleDescriptionChange}
              placeholder="e.g. Founders who attended 3+ events and have a LinkedIn"
              rows={3}
              className="w-full border rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-black placeholder-gray-300"
            />

            {/* Example query chips — helps users discover what the segment builder can do */}
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_QUERIES.map(example => (
                <button
                  key={example}
                  onClick={() => handleExampleClick(example)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    description === example
                      ? 'bg-black text-white border-black'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400 hover:text-gray-700'
                  }`}
                >
                  {example}
                </button>
              ))}
            </div>

            {/* Live preview panel */}
            {(previewLoading || preview || previewError) && (
              <div className="rounded-md border bg-gray-50 px-3 py-2.5 text-sm">
                {previewLoading && (
                  <div className="flex items-center gap-2 text-gray-400 text-xs">
                    <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                    <span>Generating segment…</span>
                  </div>
                )}
                {!previewLoading && previewError && (
                  <p className="text-red-500 text-xs">{previewError}</p>
                )}
                {!previewLoading && preview && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 text-sm">{preview.label}</span>
                      {/* Why show count prominently: the contact count is the key
                          signal — it tells the user if their description is too broad
                          or too narrow before they commit to saving. */}
                      <span className="inline-flex items-center gap-1 bg-black text-white text-xs px-2 py-0.5 rounded-full">
                        <Users className="w-3 h-3" />
                        {preview.contact_count.toLocaleString()} contacts
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">{preview.description}</p>
                    {/* Sample contacts — sanity-check: "are these actually the right people?"
                        Why 3 names not more: enough to verify intent without cluttering the preview */}
                    {preview.sample && preview.sample.length > 0 && (
                      <div className="pt-1 border-t border-gray-200">
                        <p className="text-xs text-gray-400 mb-1">Sample matches:</p>
                        <div className="space-y-0.5">
                          {preview.sample.map((c, i) => (
                            <div key={i} className="flex items-center gap-1.5 text-xs text-gray-600">
                              <span className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0" />
                              <span className="font-medium">{c.name ?? c.email}</span>
                              {c.role && <span className="text-gray-400">· {c.role}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {saveError && (
              <p className="text-red-500 text-xs">{saveError}</p>
            )}

            <div className="flex justify-end">
              <Button
                onClick={handleSave}
                disabled={saving || !description.trim() || previewLoading}
                size="sm"
              >
                {saving ? 'Saving…' : 'Save Segment'}
              </Button>
            </div>
          </div>

          {/* Saved segments list */}
          <div>
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
              Saved segments
            </h2>

            {loadingSegments ? (
              <div className="text-sm text-gray-400 animate-pulse py-4">Loading…</div>
            ) : segments.length === 0 ? (
              <div className="text-sm text-gray-400 py-4">
                No segments yet — describe an audience above to create one.
              </div>
            ) : (
              <div className="space-y-3">
                {segments.map(segment => (
                  <SegmentCard
                    key={segment.id}
                    segment={segment}
                    onDelete={handleDelete}
                    onCountUpdated={handleCountUpdated}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
