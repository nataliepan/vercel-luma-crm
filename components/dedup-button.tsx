'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Loader2, CheckCircle, XCircle } from 'lucide-react'

export function DedupButton() {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'done'; processed: number; pairsFound: number; done: boolean }
    | { status: 'error'; message: string }
  >({ status: 'idle' })

  async function handleDedup() {
    setState({ status: 'loading' })
    try {
      const res = await fetch('/api/dedup', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }))
        setState({ status: 'error', message: data.error ?? `HTTP ${res.status}` })
        return
      }
      const data = await res.json()
      setState({ status: 'done', processed: data.processed, pairsFound: data.pairsFound, done: data.done })
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message })
    }
  }

  return (
    <div className="rounded-lg border bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">
        Dedup pipeline
      </h2>
      <p className="text-xs text-gray-400 mb-4">
        Find duplicate contacts via email match and vector similarity.
      </p>

      <Button
        onClick={handleDedup}
        disabled={state.status === 'loading'}
        variant="outline"
        size="sm"
        className="w-full"
      >
        {state.status === 'loading' ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Running dedup...
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 mr-2" />
            Run dedup
          </>
        )}
      </Button>

      {state.status === 'done' && (
        <div className="mt-3 flex items-start gap-2 text-xs">
          <CheckCircle className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
          <span className="text-gray-600">
            {state.pairsFound === 0 && state.processed === 0
              ? 'No contacts to check.'
              : `Checked ${state.processed} contacts, found ${state.pairsFound} candidate pairs.${!state.done ? ' More work remaining — run again or wait for nightly cron.' : ''}`}
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
