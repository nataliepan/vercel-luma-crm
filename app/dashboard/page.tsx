import { Suspense } from 'react'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import Link from 'next/link'
import {
  Users,
  Calendar,
  Filter,
  AlertTriangle,
  Upload,
  ArrowRight,
} from 'lucide-react'
import { EmbedButton } from '@/components/embed-button'
import { DedupButton } from '@/components/dedup-button'

// Why SSR + Suspense: stats come from separate DB queries (contact count,
// event count, segment count, dedup candidates). Suspense lets each stream
// in independently as they resolve — first meaningful paint shows layout
// immediately, numbers fill in progressively. Better LCP than waiting for
// all to resolve.
//
// Why not PPR here: dashboard chrome is static (good PPR candidate) but the
// stat cards are the entire content. PPR saves the shell paint but the user
// still stares at skeletons until DB queries finish. Suspense streaming gives
// the same progressive reveal without PPR's added complexity.

// ---------------------------------------------------------------------------
// Skeleton fallback — matches stat card dimensions to prevent layout shift
// ---------------------------------------------------------------------------
function StatSkeleton() {
  return (
    <div className="rounded-lg border bg-white p-5 animate-pulse">
      <div className="flex items-center justify-between mb-3">
        <div className="h-3 w-20 bg-gray-100 rounded" />
        <div className="h-8 w-8 rounded-md bg-gray-50" />
      </div>
      <div className="h-7 w-16 bg-gray-100 rounded mb-1" />
      <div className="h-3 w-28 bg-gray-50 rounded" />
    </div>
  )
}

function RecentRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2.5 animate-pulse">
      <div className="w-7 h-7 rounded-full bg-gray-100 shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-28 bg-gray-100 rounded" />
        <div className="h-2.5 w-40 bg-gray-50 rounded" />
      </div>
    </div>
  )
}

function RecentContactsSkeleton() {
  return (
    <div className="rounded-lg border bg-white p-5">
      <div className="h-4 w-32 bg-gray-100 rounded mb-4 animate-pulse" />
      <div className="divide-y">
        {Array.from({ length: 5 }).map((_, i) => (
          <RecentRowSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat card component — used by each async RSC
// ---------------------------------------------------------------------------
function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  href,
  iconBg,
  iconColor,
}: {
  label: string
  value: number
  subtitle: string
  icon: React.ElementType
  href: string
  iconBg: string
  iconColor: string
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border bg-white p-5 hover:border-gray-300 hover:shadow-sm transition-all group"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          {label}
        </span>
        <div className={`w-8 h-8 rounded-md flex items-center justify-center ${iconBg}`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
      </div>
      <p className="text-2xl font-semibold text-gray-900">
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-gray-400 mt-1 flex items-center gap-1 group-hover:text-gray-500 transition-colors">
        {subtitle}
        <ArrowRight className="w-3 h-3 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
      </p>
    </Link>
  )
}

// Why StatErrorCard instead of throwing: each stat is wrapped in its own
// Suspense boundary. A thrown error would require an ErrorBoundary per card
// or crash the whole page. Catching and rendering a fallback card keeps the
// rest of the dashboard functional — one failed DB query doesn't take down
// the entire view.
function StatErrorCard({
  label,
  icon: Icon,
}: {
  label: string
  icon: React.ElementType
}) {
  return (
    <div className="rounded-lg border border-red-100 bg-red-50/50 p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          {label}
        </span>
        <div className="w-8 h-8 rounded-md flex items-center justify-center bg-red-50">
          <Icon className="w-4 h-4 text-red-400" />
        </div>
      </div>
      <p className="text-sm text-red-500">Failed to load</p>
      <p className="text-xs text-red-400 mt-1">Refresh to try again</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Async RSC components — each fetches one stat independently
// ---------------------------------------------------------------------------

async function ContactCount({ userId }: { userId: string }) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) FROM contacts WHERE user_id = $1 AND merged_into_id IS NULL`,
      [userId]
    )
    const count = parseInt(result.rows[0]?.count ?? '0', 10)
    return (
      <StatCard
        label="Contacts"
        value={count}
        subtitle="View all contacts"
        icon={Users}
        href="/contacts"
        iconBg="bg-blue-50"
        iconColor="text-blue-600"
      />
    )
  } catch (err) {
    console.error('Dashboard: failed to fetch contact count:', err)
    return <StatErrorCard label="Contacts" icon={Users} />
  }
}

async function EventCount({ userId }: { userId: string }) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) FROM events WHERE user_id = $1`,
      [userId]
    )
    const count = parseInt(result.rows[0]?.count ?? '0', 10)
    return (
      <StatCard
        label="Events"
        value={count}
        subtitle="From imported CSVs"
        icon={Calendar}
        href="/import"
        iconBg="bg-green-50"
        iconColor="text-green-600"
      />
    )
  } catch (err) {
    console.error('Dashboard: failed to fetch event count:', err)
    return <StatErrorCard label="Events" icon={Calendar} />
  }
}

async function SegmentCount({ userId }: { userId: string }) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) FROM segments WHERE user_id = $1`,
      [userId]
    )
    const count = parseInt(result.rows[0]?.count ?? '0', 10)
    return (
      <StatCard
        label="Segments"
        value={count}
        subtitle="Audience segments"
        icon={Filter}
        href="/segments"
        iconBg="bg-purple-50"
        iconColor="text-purple-600"
      />
    )
  } catch (err) {
    console.error('Dashboard: failed to fetch segment count:', err)
    return <StatErrorCard label="Segments" icon={Filter} />
  }
}

async function DedupQueue({ userId }: { userId: string }) {
  try {
    const result = await db.query(
      `SELECT COUNT(*) FROM dedup_candidates WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    )
    const count = parseInt(result.rows[0]?.count ?? '0', 10)
    return (
      <StatCard
        label="Duplicates"
        value={count}
        subtitle="Pending review"
        icon={AlertTriangle}
        href="/contacts"
        iconBg="bg-amber-50"
        iconColor="text-amber-600"
      />
    )
  } catch (err) {
    console.error('Dashboard: failed to fetch dedup count:', err)
    return <StatErrorCard label="Duplicates" icon={AlertTriangle} />
  }
}

// ---------------------------------------------------------------------------
// Avatar helpers — matches contacts page pattern
// ---------------------------------------------------------------------------
const AVATAR_PALETTE = [
  'bg-slate-200 text-slate-700',
  'bg-violet-100 text-violet-700',
  'bg-sky-100 text-sky-700',
  'bg-teal-100 text-teal-700',
  'bg-rose-100 text-rose-700',
  'bg-amber-100 text-amber-700',
  'bg-lime-100 text-lime-700',
  'bg-fuchsia-100 text-fuchsia-700',
]

function avatarColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

function initials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase()
  }
  return email.slice(0, 2).toUpperCase()
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  return `${diffMonths}mo ago`
}

// ---------------------------------------------------------------------------
// Recent contacts — async RSC with its own Suspense boundary
// ---------------------------------------------------------------------------
async function RecentContacts({ userId }: { userId: string }) {
  let contacts: Array<{
    id: string
    name: string | null
    email: string
    company: string | null
    role: string | null
    created_at: string
  }>

  try {
    const result = await db.query(
      `SELECT id, name, email, company, role, created_at
       FROM contacts
       WHERE user_id = $1 AND merged_into_id IS NULL
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId]
    )
    contacts = result.rows as typeof contacts
  } catch (err) {
    console.error('Dashboard: failed to fetch recent contacts:', err)
    return (
      <div className="rounded-lg border border-red-100 bg-red-50/50 p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Recent contacts</h2>
        <p className="text-sm text-red-500">Failed to load recent contacts</p>
        <p className="text-xs text-red-400 mt-1">Refresh the page to try again</p>
      </div>
    )
  }

  if (contacts.length === 0) {
    return (
      <div className="rounded-lg border bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">
          Recent contacts
        </h2>
        <div className="text-center py-8">
          <p className="text-sm text-gray-400 mb-3">No contacts yet</p>
          <Link
            href="/import"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-black hover:underline"
          >
            <Upload className="w-3.5 h-3.5" />
            Import your first CSV
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900">
          Recent contacts
        </h2>
        <Link
          href="/contacts"
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
        >
          View all
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="divide-y">
        {contacts.map((c) => (
          <div key={c.id} className="flex items-center gap-3 py-2.5">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${avatarColor(c.id)}`}
            >
              {initials(c.name, c.email)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">
                {c.name ?? c.email}
              </p>
              <p className="text-xs text-gray-400 truncate">
                {[c.role, c.company].filter(Boolean).join(' at ') || c.email}
              </p>
            </div>
            <span className="text-xs text-gray-300 shrink-0">
              {relativeTime(c.created_at)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------
function QuickActions() {
  const actions = [
    {
      label: 'Import CSV',
      description: 'Upload a Luma event export',
      href: '/import',
      icon: Upload,
    },
    {
      label: 'Build segment',
      description: 'Create an audience with plain English',
      href: '/segments',
      icon: Filter,
    },
    {
      label: 'Draft outreach',
      description: 'AI-powered message drafting',
      href: '/outreach',
      icon: ArrowRight,
    },
  ]

  return (
    <div className="rounded-lg border bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">
        Quick actions
      </h2>
      <div className="space-y-2">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-gray-50 transition-colors group"
          >
            <div className="w-8 h-8 rounded-md bg-gray-50 flex items-center justify-center group-hover:bg-gray-100 transition-colors">
              <a.icon className="w-4 h-4 text-gray-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{a.label}</p>
              <p className="text-xs text-gray-400">{a.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard page — SSR with independent Suspense boundaries
// ---------------------------------------------------------------------------
export default async function DashboardPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 py-4 border-b flex items-center justify-between">
        <h1 className="text-sm font-semibold">Dashboard</h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 max-w-5xl space-y-6">
          {/* Stat cards — each wrapped in its own Suspense boundary so they
              stream in independently as their DB queries resolve */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Suspense fallback={<StatSkeleton />}>
              <ContactCount userId={userId} />
            </Suspense>
            <Suspense fallback={<StatSkeleton />}>
              <EventCount userId={userId} />
            </Suspense>
            <Suspense fallback={<StatSkeleton />}>
              <SegmentCount userId={userId} />
            </Suspense>
            <Suspense fallback={<StatSkeleton />}>
              <DedupQueue userId={userId} />
            </Suspense>
          </div>

          {/* Bottom row: recent contacts + quick actions */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <Suspense fallback={<RecentContactsSkeleton />}>
                <RecentContacts userId={userId} />
              </Suspense>
            </div>
            <div className="space-y-4">
              <QuickActions />
              <EmbedButton />
              <DedupButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
