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
  | { status: 'series_conflict'; seriesName: string; lastImportedAt: string; existingEventId: string }
  | { status: 'overlap_conflict'; overlapPct: number; newRows: number }
  | { status: 'done'; summary: ImportSummary; eventName: string }
  | { status: 'error'; message: string }

export default function ImportPage() {
  const [state, setState] = useState<ImportState>({ status: 'idle' })
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = useCallback(async (
    file: File,
    intent?: 'new_session' | 'reexport',
    forceOverlap?: boolean
  ) => {
    setState({ status: 'importing' })

    const formData = new FormData()
    formData.append('file', file)
    if (intent) formData.append('intent', intent)
    if (forceOverlap) formData.append('force_overlap', 'true')

    try {
      const res = await fetch('/api/import', { method: 'POST', body: formData })
      const data = await res.json()

      if (res.status === 409) {
        setState({ status: 'error', message: data.message ?? 'Duplicate file.' })
        return
      }
      if (data.conflict === 'series_exists') {
        setState({ status: 'series_conflict', ...data })
        return
      }
      if (data.conflict === 'high_overlap') {
        setState({ status: 'overlap_conflict', ...data })
        return
      }
      if (!res.ok || data.error) {
        setState({ status: 'error', message: data.message ?? data.error ?? 'Import failed.' })
        return
      }
      setState({ status: 'done', summary: data.summary, eventName: data.eventName })
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

      {state.status === 'series_conflict' && (
        <div className="border rounded-lg p-6 space-y-4">
          <p className="font-medium">"{state.seriesName}" already exists</p>
          <p className="text-sm text-gray-500">
            Last imported: {new Date(state.lastImportedAt).toLocaleDateString()}
          </p>
          <p className="text-sm">Is this a new session or an updated export of the same event?</p>
          <div className="flex gap-3">
            <Button onClick={() => submit(pendingFile!, 'new_session')}>New session</Button>
            <Button variant="outline" onClick={() => submit(pendingFile!, 'reexport')}>Re-export / update</Button>
          </div>
          <button className="text-xs text-gray-400 underline" onClick={() => setState({ status: 'idle' })}>Cancel</button>
        </div>
      )}

      {state.status === 'overlap_conflict' && (
        <div className="border rounded-lg p-6 space-y-4">
          <p className="font-medium text-amber-600">Possible duplicate upload</p>
          <p className="text-sm text-gray-600">
            {state.overlapPct}% of contacts already exist. Only {state.newRows} new rows detected.
          </p>
          <div className="flex gap-3">
            <Button onClick={() => submit(pendingFile!, undefined, true)}>Proceed anyway</Button>
            <Button variant="outline" onClick={() => setState({ status: 'idle' })}>Cancel</Button>
          </div>
        </div>
      )}

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
