'use client'
// Why client component: the segment builder is highly interactive — live contact count
// preview as the user types (debounced), instant delete, and a save action.
// These require local state and event handlers that don't work in RSCs.
// SWR-style state management lets us show optimistic updates on segment creation.

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Trash2, ChevronDown, ChevronRight, Users, Sparkles } from 'lucide-react'

type Segment = {
  id: string
  label: string
  description: string
  filter_sql: string
  contact_count: number
  created_at: string
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

// SegmentCard renders a single saved segment.
// Why separate component: keeps the parent clean and allows independent
// expand/collapse state per card without lifting state into the page.
function SegmentCard({
  segment,
  onDelete,
}: {
  segment: Segment
  onDelete: (id: string) => void
}) {
  const [sqlOpen, setSqlOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!confirm(`Delete segment "${segment.label}"?`)) return
    setDeleting(true)
    await fetch(`/api/segments?id=${segment.id}`, { method: 'DELETE' })
    onDelete(segment.id)
  }

  return (
    <div className="border rounded-lg p-4 bg-white hover:border-gray-300 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-sm text-gray-900 truncate">{segment.label}</span>
            {/* Contact count badge */}
            <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded shrink-0">
              <Users className="w-3 h-3" />
              {segment.contact_count.toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-gray-500 leading-snug">{segment.description}</p>
          <p className="text-xs text-gray-400 mt-1.5">{relativeTime(segment.created_at)}</p>
        </div>

        <button
          onClick={handleDelete}
          disabled={deleting}
          className="p-1.5 text-gray-400 hover:text-red-500 transition-colors shrink-0 disabled:opacity-50"
          aria-label={`Delete ${segment.label}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Collapsible SQL — transparent but not distracting */}
      <div className="mt-3">
        <button
          onClick={() => setSqlOpen(o => !o)}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          {sqlOpen ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          View SQL filter
        </button>
        {sqlOpen && (
          <pre className="mt-2 p-2.5 bg-gray-50 rounded text-xs text-gray-600 overflow-x-auto whitespace-pre-wrap break-all font-mono">
            {segment.filter_sql}
          </pre>
        )}
      </div>
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
