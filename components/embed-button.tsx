'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Sparkles, Loader2, CheckCircle, XCircle } from 'lucide-react'

export function EmbedButton() {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'done'; processed: number; failed: number; total: number }
    | { status: 'error'; message: string }
  >({ status: 'idle' })

  async function handleEmbed() {
    setState({ status: 'loading' })
    try {
      const res = await fetch('/api/embed', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }))
        setState({ status: 'error', message: data.error ?? `HTTP ${res.status}` })
        return
      }
      const data = await res.json()
      setState({ status: 'done', processed: data.processed, failed: data.failed, total: data.total })
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message })
    }
  }

  return (
    <div className="rounded-lg border bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">
        Embedding pipeline
      </h2>
      <p className="text-xs text-gray-400 mb-4">
        Generate vector embeddings for pending contacts. Powers NL search and dedup.
      </p>

      <Button
        onClick={handleEmbed}
        disabled={state.status === 'loading'}
        variant="outline"
        size="sm"
        className="w-full"
      >
        {state.status === 'loading' ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Embedding...
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4 mr-2" />
            Embed contacts
          </>
        )}
      </Button>

      {state.status === 'done' && (
        <div className="mt-3 flex items-start gap-2 text-xs">
          <CheckCircle className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
          <span className="text-gray-600">
            {state.total === 0
              ? 'No pending contacts to embed.'
              : `Processed ${state.processed} of ${state.total} contacts.${state.failed > 0 ? ` ${state.failed} failed (will retry on next cron run).` : ''}`}
          </span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="mt-3 flex items-start gap-2 text-xs">
          <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
          <span className="text-red-600">{state.message}</span>
        </div>
      )}
    </div>
  )
}
