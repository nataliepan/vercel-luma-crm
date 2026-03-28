'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

export default function ImportError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Import error:', error)
  }, [error])

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b">
        <h1 className="text-sm font-semibold">Import</h1>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-5 h-5 text-red-500" />
          </div>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">
            Something went wrong
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            We couldn&apos;t load the import page. This is usually temporary.
          </p>
          <Button onClick={reset} size="sm">
            Try again
          </Button>
        </div>
      </div>
    </div>
  )
}
