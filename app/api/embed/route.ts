import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { embedPendingContacts } from '@/lib/embeddings'

// Why maxDuration=300: embedding 200k contacts in batches of 2048 takes
// ~98 OpenAI API calls. Each call ~1-3s + DB write time. 300s gives headroom.
export const maxDuration = 300

export async function POST() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await embedPendingContacts(userId)
    return NextResponse.json(result)
  } catch (err) {
    console.error('Embedding job failed:', err)
    return NextResponse.json(
      { error: 'Embedding job failed', detail: (err as Error).message },
      { status: 500 }
    )
  }
}
