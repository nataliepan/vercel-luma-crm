import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await db.query(
      `SELECT COUNT(*) FROM contacts WHERE user_id = $1 AND merged_into_id IS NULL`,
      [userId]
    )
    return NextResponse.json({ count: parseInt(result.rows[0]?.count ?? '0', 10) })
  } catch (err) {
    console.error('GET /api/contacts/count error:', err)
    return NextResponse.json({ error: 'Failed to fetch contact count' }, { status: 500 })
  }
}
