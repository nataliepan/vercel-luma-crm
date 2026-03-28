'use client'
// Why client component: the outreach drafter is fully interactive —
// segment picker, context input, streaming draft output, copy/regenerate.

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Sparkles, Copy, Check, RefreshCw, ChevronDown } from 'lucide-react'

type Segment = {
  id: string
  label: string
  description: string
  contact_count: number
}

const OUTREACH_TYPES = [
  { value: 'event_invite', label: 'Event invite' },
  { value: 'newsletter', label: 'Newsletter' },
  { value: 'speaker_ask', label: 'Speaker ask' },
  { value: 'sponsor_ask', label: 'Sponsor ask' },
  { value: 'general', label: 'General outreach' },
]

export default function OutreachPage() {
  const [segments, setSegments] = useState<Segment[]>([])
  const [segmentsLoading, setSegmentsLoading] = useState(true)
  const [selectedSegmentId, setSelectedSegmentId] = useState('')
  const [outreachType, setOutreachType] = useState('event_invite')
  const [context, setContext] = useState('')

  // Streaming state — built up chunk by chunk as the response arrives
  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)

  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Abort controller lets us cancel an in-flight stream if the user hits Regenerate
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/segments')
        const data = await res.json()
        if (!res.ok) {
          console.error('Failed to load segments:', data?.error)
          // Degrade gracefully — the picker shows "No segments yet" with a link to create one
        } else {
          setSegments(data.segments ?? [])
          if (data.segments?.length > 0) setSelectedSegmentId(data.segments[0].id)
        }
      } catch (err) {
        console.error('Failed to load segments:', err)
      } finally {
        setSegmentsLoading(false)
      }
    }
    load()
  }, [])

  const selectedSegment = segments.find(s => s.id === selectedSegmentId)

  // Why plain fetch + ReadableStream not useChat: useChat in AI SDK v6 changed
  // its API significantly (sendMessage, TextStreamChatTransport, etc.) and the
  // body passthrough for custom fields (segmentId, type) is unreliable.
  // For a one-shot generation — no multi-turn conversation needed — streaming
  // fetch with a TextDecoder is simpler, more transparent, and easier to debug.
  async function handleGenerate() {
    if (!selectedSegmentId || !context.trim() || isStreaming) return

    // Cancel any previous in-flight request
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setDraft('')
    setStreamError(null)
    setIsStreaming(true)

    try {
      const res = await fetch('/api/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentId: selectedSegmentId, context, type: outreachType }),
        signal: controller.signal,
      })

      if (!res.ok) {
        // Avoid showing raw HTML (e.g. auth redirects) — extract plain text or use a generic message
        const errText = await res.text()
        const isHtml = errText.trimStart().startsWith('<')
        setStreamError(isHtml ? `Request failed (${res.status})` : errText || `Request failed (${res.status})`)
        return
      }

      if (!res.body) {
        setStreamError('No response from server — try again')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        setDraft(prev => prev + decoder.decode(value, { stream: true }))
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setStreamError((err as Error).message ?? 'Something went wrong — try again')
      }
    } finally {
      setIsStreaming(false)
    }
  }

  function handleCopy() {
    if (!draft) return
    navigator.clipboard.writeText(draft)
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  const canGenerate = !!selectedSegmentId && !!context.trim() && !isStreaming

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b">
        <h1 className="text-sm font-semibold">Outreach</h1>
        <p className="text-xs text-gray-400 mt-0.5">Draft personalized messages for a segment</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-5">

          {/* Segment picker */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Segment
            </label>
            {segmentsLoading ? (
              <div className="text-sm text-gray-400 animate-pulse">Loading segments…</div>
            ) : segments.length === 0 ? (
              <p className="text-sm text-gray-400">
                No segments yet —{' '}
                <a href="/segments" className="text-blue-500 hover:underline">create one first</a>.
              </p>
            ) : (
              <div className="relative">
                <select
                  value={selectedSegmentId}
                  onChange={e => setSelectedSegmentId(e.target.value)}
                  className="w-full border rounded-md px-3 py-2 text-sm appearance-none bg-white focus:outline-none focus:ring-1 focus:ring-black pr-8"
                >
                  {segments.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.label} ({s.contact_count.toLocaleString()} contacts)
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>
            )}
            {selectedSegment && (
              <p className="text-xs text-gray-400">{selectedSegment.description}</p>
            )}
          </div>

          {/* Outreach type chips */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Type
            </label>
            <div className="flex flex-wrap gap-1.5">
              {OUTREACH_TYPES.map(t => (
                <button
                  key={t.value}
                  onClick={() => setOutreachType(t.value)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    outreachType === t.value
                      ? 'bg-black text-white border-black'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400 hover:text-gray-700'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Context */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Context
            </label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder={
                outreachType === 'event_invite'
                  ? 'e.g. Invite to our AI founders dinner on March 15th in SF — limited to 20 people'
                  : outreachType === 'speaker_ask'
                  ? 'e.g. Looking for a speaker for our April demo day — 15 min talk on building with AI'
                  : outreachType === 'newsletter'
                  ? 'e.g. Monthly update — new events, community highlights, upcoming workshops'
                  : 'Describe what this outreach is for…'
              }
              rows={3}
              className="w-full border rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-black placeholder-gray-300"
            />
          </div>

          {/* Generate button */}
          <div className="flex justify-end">
            <Button onClick={handleGenerate} disabled={!canGenerate} className="flex items-center gap-2">
              <Sparkles className={`w-3.5 h-3.5 ${isStreaming ? 'animate-pulse' : ''}`} />
              {isStreaming ? 'Drafting…' : draft ? 'Regenerate' : 'Draft message'}
            </Button>
          </div>

          {/* Error */}
          {streamError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {streamError}
            </div>
          )}

          {/* Streaming draft output */}
          {(isStreaming || draft) && (
            <div className="rounded-lg border bg-white">
              <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50">
                <span className="text-xs font-medium text-gray-500">Draft</span>
                <div className="flex items-center gap-2">
                  {isStreaming && (
                    <span className="flex items-center gap-1.5 text-xs text-gray-400">
                      <Sparkles className="w-3 h-3 animate-pulse" />
                      Writing…
                    </span>
                  )}
                  {draft && !isStreaming && (
                    <>
                      <button
                        onClick={handleGenerate}
                        className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 transition-colors"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Regenerate
                      </button>
                      <button
                        onClick={handleCopy}
                        className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 transition-colors"
                      >
                        {copied
                          ? <><Check className="w-3 h-3 text-green-500" /> Copied</>
                          : <><Copy className="w-3 h-3" /> Copy</>}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {/* whitespace-pre-wrap preserves paragraph breaks from the model output */}
              <div className="px-4 py-4 text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
                {draft}
                {isStreaming && (
                  <span className="inline-block w-0.5 h-4 bg-gray-400 animate-pulse ml-0.5 align-middle" />
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
