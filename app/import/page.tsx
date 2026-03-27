'use client'
// Why client component: CSV upload is interactive — file picker, drag-drop,
// multi-step conflict resolution. RSC would require round-trips for each step.

import { useState, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'

type ImportSummary = {
  newContacts: number
  updatedContacts: number
  existedContacts: number
  totalRows: number
}

type ImportState =
  | { status: 'idle' }
  | { status: 'importing' }
  | { status: 'same_event'; eventName: string; existingExportedAt: string; newExportedAt: string | null; existingEventId: string }
  | { status: 'done'; summary: ImportSummary; eventName: string }
  | { status: 'error'; message: string }

export default function ImportPage() {
  const [state, setState] = useState<ImportState>({ status: 'idle' })
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = useCallback(async (
    file: File,
    mergeStrategy?: 'use_new' | 'keep_existing',
    existingEventId?: string
  ) => {
    setState({ status: 'importing' })

    const formData = new FormData()
    formData.append('file', file)
    if (mergeStrategy) formData.append('merge_strategy', mergeStrategy)
    if (existingEventId) formData.append('existing_event_id', existingEventId)

    try {
      const res = await fetch('/api/import', { method: 'POST', body: formData })

      // Safely parse — a DB or AI crash returns HTML 500, not JSON.
      // Parsing HTML as JSON throws a SyntaxError which would show as "Network error".
      const text = await res.text()
      let data: Record<string, unknown> = {}
      try { data = JSON.parse(text) } catch {
        setState({ status: 'error', message: `Server error (${res.status}) — check server logs.` })
        return
      }

      const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)

      if (res.status === 409) {
        setState({ status: 'error', message: str(data.message, 'Duplicate file.') })
        return
      }
      if (data.conflict === 'same_event') {
        setState({
          status: 'same_event',
          eventName: str(data.eventName, ''),
          existingExportedAt: str(data.existingExportedAt, ''),
          newExportedAt: typeof data.newExportedAt === 'string' ? data.newExportedAt : null,
          existingEventId: str(data.existingEventId, ''),
        })
        return
      }
      if (!res.ok || data.error) {
        setState({ status: 'error', message: str(data.message ?? data.error, 'Import failed.') })
        return
      }
      setState({ status: 'done', summary: data.summary as ImportSummary, eventName: str(data.eventName, '') })
    } catch {
      setState({ status: 'error', message: 'Network error — please try again.' })
    }
  }, [])

  const handleFile = useCallback((file: File) => {
    setPendingFile(file)
    submit(file)
  }, [submit])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  return (
    <div className="max-w-xl mx-auto py-16 px-4">
      <h1 className="text-2xl font-semibold mb-2">Import Contacts</h1>
      <p className="text-sm text-gray-500 mb-8">Upload a Luma guest list CSV to import contacts.</p>

      {state.status === 'idle' && (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors
            ${isDragging ? 'border-black bg-gray-50' : 'border-gray-300 hover:border-gray-400'}`}
        >
          <p className="text-sm font-medium">Drop a CSV file here</p>
          <p className="text-xs text-gray-400 mt-1">or click to browse</p>
          <p className="text-xs text-gray-400 mt-3">CSV files up to 10MB · 50,000 rows max</p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          />
        </div>
      )}

      {state.status === 'importing' && (
        <div className="border rounded-lg p-12 text-center text-sm text-gray-500">
          <div className="animate-pulse">Importing{pendingFile ? ` "${pendingFile.name}"` : ''}…</div>
          <p className="text-xs mt-2 text-gray-400">AI is normalizing column headers</p>
        </div>
      )}

      {state.status === 'same_event' && (() => {
        const existingDate = new Date(state.existingExportedAt)
        const newDate = state.newExportedAt ? new Date(state.newExportedAt) : null
        // Determine which export is newer so we can label the options clearly.
        const uploadIsNewer = newDate ? newDate > existingDate : false
        return (
          <div className="border rounded-lg p-6 space-y-4">
            <p className="font-medium">This looks like the same event</p>
            <p className="text-sm text-gray-500">
              "{state.eventName}" was already imported. New contacts will be added either way — choose how to handle contacts that already exist.
            </p>
            <div className="flex flex-col gap-2 text-sm text-gray-500">
              <div className="flex justify-between">
                <span>Existing export</span>
                <span>{existingDate.toLocaleString()}{!uploadIsNewer && <span className="ml-2 text-xs font-medium text-black">← newer</span>}</span>
              </div>
              <div className="flex justify-between">
                <span>This file</span>
                <span>{newDate ? newDate.toLocaleString() : 'no date'}{uploadIsNewer && <span className="ml-2 text-xs font-medium text-black">← newer</span>}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Button onClick={() => submit(pendingFile!, uploadIsNewer ? 'use_new' : 'keep_existing', state.existingEventId)}>
                Use newest info{uploadIsNewer ? ' (this file)' : ' (keep existing)'}
              </Button>
              <Button variant="outline" onClick={() => submit(pendingFile!, uploadIsNewer ? 'keep_existing' : 'use_new', state.existingEventId)}>
                Use oldest info{uploadIsNewer ? ' (keep existing)' : ' (this file)'}
              </Button>
              <button className="text-xs text-gray-400 underline text-left" onClick={() => setState({ status: 'idle' })}>Cancel</button>
            </div>
          </div>
        )
      })()}

      {state.status === 'done' && (
        <div className="border rounded-lg p-6 space-y-4">
          <p className="font-medium text-green-700">Import complete — {state.eventName}</p>
          <div className="text-sm space-y-1">
            <p><span className="font-medium">{state.summary.newContacts}</span> new contacts</p>
            <p><span className="font-medium">{state.summary.updatedContacts}</span> updated</p>
            <p><span className="font-medium">{state.summary.existedContacts}</span> already existed</p>
            <p className="text-gray-400 text-xs">{state.summary.totalRows} rows processed</p>
          </div>
          <div className="flex gap-3">
            <Button onClick={() => { setState({ status: 'idle' }); setPendingFile(null) }}>Import another</Button>
            <a href="/contacts"><Button variant="outline">View contacts</Button></a>
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <div className="border border-red-200 rounded-lg p-6 space-y-4">
          <p className="text-sm text-red-600">{state.message}</p>
          <Button variant="outline" onClick={() => { setState({ status: 'idle' }); setPendingFile(null) }}>Try again</Button>
        </div>
      )}
    </div>
  )
}
