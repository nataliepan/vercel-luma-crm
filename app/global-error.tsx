'use client'

// Why global-error.tsx: catches errors that escape route-level error.tsx boundaries,
// including failures in the root layout (e.g. ClerkProvider crash, font loading error).
// This is the last-resort fallback — it renders a minimal standalone page (no layout)
// so even a broken layout doesn't leave the user staring at a blank screen.

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Global error:', error)
  }, [error])

  return (
    <html lang="en">
      <body className="flex items-center justify-center min-h-screen bg-white font-sans">
        <div className="text-center max-w-sm px-6">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h1 className="text-base font-semibold text-gray-900 mb-1">
            Something went wrong
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            An unexpected error occurred. This is usually temporary.
          </p>
          <button
            onClick={reset}
            className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-black rounded-md hover:bg-gray-800 transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
