import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { dedupForUser } from '@/lib/dedup'

// Why maxDuration=300: dedup with vector similarity queries across thousands
// of contacts can take several minutes, especially after a bulk import.
export const maxDuration = 300

export async function POST() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await dedupForUser(userId)
    return NextResponse.json(result)
  } catch (err) {
    console.error('Dedup job failed:', err)
    return NextResponse.json(
      { error: 'Dedup job failed', detail: (err as Error).message },
      { status: 500 }
    )
  }
}
