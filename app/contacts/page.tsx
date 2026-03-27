'use client'
// Why client component: search input is interactive — user types and results
// update without a full page reload. Keyset pagination also needs client state
// to track the cursor. A pure RSC would require a round-trip per keystroke.

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'

type Contact = {
  id: string
  name: string | null
  email: string
  company: string | null
  role: string | null
  embedding_status: string
  created_at: string
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
    const data = await res.json()
    setLoading(false)

    if (cursor) {
      // Append next page
      setContacts(prev => [...prev, ...data.contacts])
    } else {
      setContacts(data.contacts)
    }
    setNextCursor(data.nextCursor)
  }, [])

  // Fetch total count once on mount for the header
  useEffect(() => {
    fetch('/api/contacts/count')
      .then(r => r.json())
      .then(d => setTotal(d.count))
      .catch(() => {})
  }, [])

  // Initial load
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
    debounceRef.current = setTimeout(() => {
      fetchContacts(val)
    }, 300)
  }

  return (
    <div className="max-w-5xl mx-auto py-10 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          {total !== null && (
            <p className="text-sm text-gray-500 mt-0.5">{total.toLocaleString()} total</p>
          )}
        </div>
        <a href="/import">
          <Button>Import CSV</Button>
        </a>
      </div>

      <input
        type="text"
        value={query}
        onChange={handleSearch}
        placeholder="Search by name, email, company, or role…"
        className="w-full border rounded-md px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-1 focus:ring-black"
      />

      {contacts.length === 0 && !loading ? (
        <div className="text-center py-16 text-sm text-gray-400">
          {query ? 'No contacts matched your search.' : 'No contacts yet — import a CSV to get started.'}
        </div>
      ) : (
        <>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Email</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Company</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Role</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 w-20">Embed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {contacts.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium">{c.name ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2.5 text-gray-600">{c.email}</td>
                    <td className="px-4 py-2.5 text-gray-600">{c.company ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2.5 text-gray-600">{c.role ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                        c.embedding_status === 'done'
                          ? 'bg-green-50 text-green-700'
                          : c.embedding_status === 'failed'
                          ? 'bg-red-50 text-red-600'
                          : 'bg-gray-100 text-gray-500'
                      }`}>
                        {c.embedding_status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nextCursor && !query && (
            <div className="mt-4 text-center">
              <Button
                variant="outline"
                onClick={() => fetchContacts(query, nextCursor)}
                disabled={loading}
              >
                {loading ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}

          {loading && contacts.length === 0 && (
            <div className="text-center py-8 text-sm text-gray-400 animate-pulse">Loading…</div>
          )}
        </>
      )}
    </div>
  )
}
