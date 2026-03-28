'use client'
// Why client component: search input is interactive — user types and results
// update without a full page reload. Keyset pagination also needs client state
// to track the cursor. A pure RSC would require a round-trip per keystroke.

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { SlidersHorizontal, LayoutList } from 'lucide-react'

type Contact = {
  id: string
  name: string | null
  email: string
  company: string | null
  role: string | null
  embedding_status: string
  created_at: string
}

// Deterministic color from any string — maps roles/companies to consistent tag colors
const TAG_PALETTE = [
  'bg-blue-50 text-blue-700 border border-blue-200',
  'bg-purple-50 text-purple-700 border border-purple-200',
  'bg-green-50 text-green-700 border border-green-200',
  'bg-orange-50 text-orange-700 border border-orange-200',
  'bg-pink-50 text-pink-700 border border-pink-200',
  'bg-cyan-50 text-cyan-700 border border-cyan-200',
  'bg-amber-50 text-amber-700 border border-amber-200',
  'bg-rose-50 text-rose-700 border border-rose-200',
]

function tagColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff
  }
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length]
}

function initials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase()
  }
  return email.slice(0, 2).toUpperCase()
}

// Avatar background color — same hash approach as tags but pulls from a muted palette
const AVATAR_PALETTE = [
  'bg-slate-200 text-slate-700',
  'bg-violet-100 text-violet-700',
  'bg-sky-100 text-sky-700',
  'bg-teal-100 text-teal-700',
  'bg-rose-100 text-rose-700',
  'bg-amber-100 text-amber-700',
  'bg-lime-100 text-lime-700',
  'bg-fuchsia-100 text-fuchsia-700',
]

function avatarColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  return `${diffMonths}mo ago`
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchContacts = useCallback(async (q: string, cursor?: string | null) => {
    setLoading(true)
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (cursor) params.set('cursor', cursor)

    const res = await fetch(`/api/contacts?${params}`)
    setLoading(false)

    // Guard: non-2xx or empty responses (e.g. Clerk auth redirects) can't be parsed
    // as JSON — fall back to empty state rather than crashing.
    if (!res.ok) {
      if (!cursor) setContacts([])
      return
    }

    let data: { contacts?: Contact[]; nextCursor?: string | null }
    try {
      data = await res.json()
    } catch {
      // Malformed JSON (e.g. Clerk redirect returned HTML) — treat as empty
      if (!cursor) setContacts([])
      return
    }

    if (cursor) {
      setContacts(prev => [...prev, ...(data.contacts ?? [])])
    } else {
      setContacts(data.contacts ?? [])
    }
    setNextCursor(data.nextCursor ?? null)
  }, [])

  useEffect(() => {
    fetch('/api/contacts/count')
      .then(r => r.json())
      .then(d => setTotal(d.count))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchContacts('')
  }, [fetchContacts])

  // Debounced search — wait 300ms after last keystroke before querying
  // Why debounce: trigram search on 25k rows is fast but we still don't want
  // a query per character. 300ms matches perceived instant response.
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchContacts(val), 300)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 py-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Contacts</h1>
          {total !== null && (
            <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
              {total.toLocaleString()}
            </span>
          )}
        </div>
        <a href="/import">
          <Button size="sm">+ Import CSV</Button>
        </a>
      </div>

      {/* Toolbar: search + filter/display controls */}
      <div className="px-6 py-2.5 border-b flex items-center gap-3">
        <input
          type="text"
          value={query}
          onChange={handleSearch}
          placeholder="Search by name, email, company, or role…"
          className="flex-1 border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-black"
        />
        <Button variant="outline" size="sm" className="gap-1.5 text-gray-600">
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Filter
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5 text-gray-600">
          <LayoutList className="w-3.5 h-3.5" />
          Display
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {contacts.length === 0 && !loading ? (
          <div className="text-center py-20 text-sm text-gray-400">
            {query ? 'No contacts matched your search.' : 'No contacts yet — import a CSV to get started.'}
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b sticky top-0 bg-white z-10">
                <tr>
                  <th className="text-left px-6 py-2.5 font-medium text-gray-500 text-xs">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Email</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Company</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Role</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {contacts.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    {/* Name with initials avatar */}
                    <td className="px-6 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${avatarColor(c.id)}`}>
                          {initials(c.name, c.email)}
                        </div>
                        <span className="font-medium text-gray-900">
                          {c.name ?? <span className="text-gray-400 font-normal">—</span>}
                        </span>
                      </div>
                    </td>

                    {/* Email */}
                    <td className="px-4 py-2.5 text-gray-500">{c.email}</td>

                    {/* Company as tag */}
                    <td className="px-4 py-2.5">
                      {c.company ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${tagColor(c.company)}`}>
                          {c.company}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    {/* Role as tag */}
                    <td className="px-4 py-2.5">
                      {c.role ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${tagColor(c.role)}`}>
                          {c.role}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    {/* Relative timestamp */}
                    <td className="px-4 py-2.5 text-gray-400 text-xs">
                      {relativeTime(c.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {nextCursor && !query && (
              <div className="px-6 py-4 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchContacts(query, nextCursor)}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}

            {loading && contacts.length === 0 && (
              <div className="text-center py-10 text-sm text-gray-400 animate-pulse">Loading…</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
