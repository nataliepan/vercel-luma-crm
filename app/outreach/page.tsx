'use client'
// Why client component: the outreach drafter is fully interactive —
// segment picker, context input, streaming draft output, copy/regenerate.

import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Sparkles, Copy, Check, RefreshCw, ChevronDown, ChevronLeft, ChevronRight, Users, AlertTriangle } from 'lucide-react'

type Segment = {
  id: string
  label: string
  description: string
  contact_count: number
}

type Contact = {
  name: string | null
  role: string | null
  company: string | null
}

const OUTREACH_TYPES = [
  { value: 'event_invite', label: 'Event invite' },
  { value: 'newsletter', label: 'Newsletter' },
  { value: 'speaker_ask', label: 'Speaker ask' },
  { value: 'sponsor_ask', label: 'Sponsor ask' },
  { value: 'general', label: 'General outreach' },
]

// Bracket placeholders the AI is instructed to use.
// Substitution is case-insensitive so [Name] and [name] both work.
const PLACEHOLDERS = ['name', 'company', 'role'] as const
type Placeholder = typeof PLACEHOLDERS[number]

/** Fill [name], [company], [role] placeholders with values from a contact. */
function fillTemplate(template: string, contact: Contact): string {
  const firstName = contact.name?.split(' ')[0] ?? null
  return template
    .replace(/\[name\]/gi, firstName ?? '[name]')
    .replace(/\[company\]/gi, contact.company ?? '[company]')
    .replace(/\[role\]/gi, contact.role ?? '[role]')
}

/** Return true if the template still has any unfilled placeholders after substitution. */
function hasUnfilledPlaceholders(filled: string): boolean {
  return PLACEHOLDERS.some(p => filled.toLowerCase().includes(`[${p}]`))
}

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

  // Personalization state
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactIndex, setContactIndex] = useState(0)
  const [personalizeCopied, setPersonalizeCopied] = useState(false)
  const personalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hallucination check — runs automatically after streaming completes
  const [hallucinationIssues, setHallucinationIssues] = useState<string[]>([])
  const [checkingHallucinations, setCheckingHallucinations] = useState(false)
  // Abort controller lets us cancel an in-flight stream if the user hits Regenerate
  const abortRef = useRef<AbortController | null>(null)

  // Cleanup abort controller and copy timer on unmount — prevents setState on
  // unmounted component and cancels in-flight stream if user navigates away.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

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

  // Reset contacts when segment changes
  useEffect(() => {
    setContacts([])
    setContactIndex(0)
  }, [selectedSegmentId])

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
    setHallucinationIssues([])
    setCheckingHallucinations(false)
    setIsStreaming(true)
    // Reset personalization when regenerating — stale contacts stay loaded for reuse
    setContactIndex(0)

    let completedDraft = ''

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
        const chunk = decoder.decode(value, { stream: true })
        completedDraft += chunk
        setDraft(prev => prev + chunk)
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setStreamError((err as Error).message ?? 'Something went wrong — try again')
      }
    } finally {
      setIsStreaming(false)
    }

    // Run hallucination check after stream completes.
    // Why post-stream not inline: checking inline would block the stream or negate
    // the streaming UX. Running after lets the user read the draft while the check
    // happens in the background.
    if (completedDraft && !controller.signal.aborted) {
      setCheckingHallucinations(true)
      try {
        const seg = segments.find(s => s.id === selectedSegmentId)
        const checkRes = await fetch('/api/outreach/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            draft: completedDraft,
            contact: {
              name: seg?.label ?? '',
              role: '',
              company: '',
              events: [],
            },
          }),
          signal: controller.signal,
        })
        if (checkRes.ok) {
          const result = await checkRes.json()
          if (result.flagged && result.issues?.length > 0) {
            setHallucinationIssues(result.issues)
          }
        }
      } catch {
        // Hallucination check is non-critical — if it fails, the draft is still usable
      } finally {
        setCheckingHallucinations(false)
      }
    }
  }

  function handleCopy() {
    if (!draft) return
    navigator.clipboard.writeText(draft)
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  // Lazy-load contacts for the selected segment on first "Personalize" click.
  // Why lazy not eager: most users will just copy the template — loading contacts
  // on every segment switch would be wasteful. Only fetch when explicitly requested.
  async function handlePersonalize() {
    if (contacts.length > 0) return // already loaded
    if (!selectedSegmentId) return

    setContactsLoading(true)
    try {
      const res = await fetch(`/api/segments/${selectedSegmentId}/contacts`)
      const data = await res.json()
      if (res.ok) {
        setContacts(data.contacts ?? [])
        setContactIndex(0)
      } else {
        console.error('Failed to load contacts:', data?.error)
      }
    } catch (err) {
      console.error('Failed to load contacts:', err)
    } finally {
      setContactsLoading(false)
    }
  }

  function handlePersonalizeCopy(filled: string) {
    navigator.clipboard.writeText(filled)
    setPersonalizeCopied(true)
    if (personalizeTimerRef.current) clearTimeout(personalizeTimerRef.current)
    personalizeTimerRef.current = setTimeout(() => setPersonalizeCopied(false), 2000)
  }

  const canGenerate = !!selectedSegmentId && !!context.trim() && !isStreaming
  const currentContact = contacts[contactIndex] ?? null
  const filledDraft = currentContact ? fillTemplate(draft, currentContact) : ''
  const unfilled = currentContact ? hasUnfilledPlaceholders(filledDraft) : false

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

          {/* Draft — editable textarea so the user can tweak the template */}
          {(isStreaming || draft) && (
            <div className="rounded-lg border bg-white">
              <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50">
                <span className="text-xs font-medium text-gray-500">Template draft</span>
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
                          : <><Copy className="w-3 h-3" /> Copy template</>}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {/* Editable textarea — user can adjust [name]/[company]/[role] brackets or
                  rewrite sections. Changes persist in `draft` state so personalization
                  uses the updated version automatically. */}
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                disabled={isStreaming}
                rows={8}
                className="w-full px-4 py-4 text-sm text-gray-800 leading-relaxed resize-none focus:outline-none rounded-b-lg disabled:bg-transparent"
              />
              {draft && !isStreaming && (
                <div className="px-4 pb-3">
                  <p className="text-xs text-gray-400">
                    Edit the template above, then use{' '}
                    <span className="font-mono bg-gray-100 px-1 rounded">[name]</span>,{' '}
                    <span className="font-mono bg-gray-100 px-1 rounded">[company]</span>,{' '}
                    <span className="font-mono bg-gray-100 px-1 rounded">[role]</span>{' '}
                    as placeholders — then personalize below.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Personalization panel — lazy-loaded on first click */}
          {draft && !isStreaming && (
            <div className="rounded-lg border bg-white">
              <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50">
                <span className="text-xs font-medium text-gray-500">Personalize per contact</span>
                {contacts.length > 0 && (
                  <span className="text-xs text-gray-400">
                    {contactIndex + 1} / {contacts.length}
                  </span>
                )}
              </div>

              {contacts.length === 0 ? (
                <div className="px-4 py-4 flex items-center justify-between">
                  <p className="text-sm text-gray-500">
                    Fill in brackets for each contact and copy one by one.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePersonalize}
                    disabled={contactsLoading}
                    className="flex items-center gap-1.5 text-xs shrink-0 ml-4"
                  >
                    <Users className="w-3.5 h-3.5" />
                    {contactsLoading ? 'Loading…' : 'Load contacts'}
                  </Button>
                </div>
              ) : (
                <div className="px-4 py-4 space-y-3">
                  {/* Contact navigator */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setContactIndex(i => Math.max(0, i - 1)); setPersonalizeCopied(false) }}
                      disabled={contactIndex === 0}
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      aria-label="Previous contact"
                    >
                      <ChevronLeft className="w-4 h-4 text-gray-500" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {currentContact?.name ?? '(no name)'}
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        {[currentContact?.role, currentContact?.company].filter(Boolean).join(' · ') || 'No role or company'}
                      </p>
                    </div>
                    <button
                      onClick={() => { setContactIndex(i => Math.min(contacts.length - 1, i + 1)); setPersonalizeCopied(false) }}
                      disabled={contactIndex === contacts.length - 1}
                      className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      aria-label="Next contact"
                    >
                      <ChevronRight className="w-4 h-4 text-gray-500" />
                    </button>
                  </div>

                  {/* Filled preview — read-only */}
                  {unfilled && (
                    <p className="text-xs text-amber-600">
                      Some placeholders couldn&apos;t be filled — this contact is missing data for the highlighted fields.
                    </p>
                  )}
                  <div className="rounded-md border bg-gray-50 px-3 py-3 text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
                    {filledDraft}
                  </div>

                  {/* Copy this contact's version */}
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-400">
                      Copy, send, then move to the next →
                    </p>
                    <button
                      onClick={() => handlePersonalizeCopy(filledDraft)}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-gray-200 hover:border-gray-400 hover:text-gray-700 text-gray-500 transition-colors"
                    >
                      {personalizeCopied
                        ? <><Check className="w-3 h-3 text-green-500" /> Copied!</>
                        : <><Copy className="w-3 h-3" /> Copy for {currentContact?.name?.split(' ')[0] ?? 'contact'}</>
                      }
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Hallucination check status / warnings */}
          {checkingHallucinations && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Sparkles className="w-3 h-3 animate-pulse" />
              Checking draft for accuracy…
            </div>
          )}
          {hallucinationIssues.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800">Potential accuracy issues</p>
                  <ul className="mt-1 space-y-0.5">
                    {hallucinationIssues.map((issue, i) => (
                      <li key={i} className="text-xs text-amber-700">• {issue}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-amber-600">
                    Review these before sending — the draft may reference details not in your contact data.
                  </p>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
