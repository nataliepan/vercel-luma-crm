'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useClerk, useUser } from '@clerk/nextjs'
import { Users, Upload, Search, Filter, Mail, LayoutDashboard, LogOut } from 'lucide-react'

const records = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/segments', label: 'Segments', icon: Filter },
  { href: '/outreach', label: 'Outreach', icon: Mail },
  { href: '/import', label: 'Import', icon: Upload },
]

export function Sidebar() {
  const pathname = usePathname()
  const { signOut } = useClerk()
  const { user } = useUser()

  return (
    <aside className="w-56 shrink-0 border-r bg-white flex flex-col h-full overflow-y-auto">
      {/* Workspace header */}
      <div className="px-4 py-3 flex items-center gap-2.5 border-b">
        <div className="w-5 h-5 rounded bg-black flex items-center justify-center shrink-0">
          <span className="text-white text-[10px] font-bold leading-none">L</span>
        </div>
        <span className="text-sm font-semibold truncate">Luma CRM</span>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-gray-50 text-gray-400 text-sm cursor-pointer hover:bg-gray-100 transition-colors">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span>Search</span>
        </div>
      </div>

      {/* Records section */}
      <nav className="px-3 py-3 flex-1">
        <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wider px-2 mb-1.5">
          Records
        </p>
        {records.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
                active
                  ? 'bg-gray-100 text-black font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-black'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* User + sign out */}
      <div className="px-3 py-3 border-t">
        <div className="flex items-center gap-2.5 px-2 mb-2">
          <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
            <span className="text-[10px] font-semibold text-gray-600">
              {user?.firstName?.[0] ?? user?.emailAddresses?.[0]?.emailAddress?.[0]?.toUpperCase() ?? '?'}
            </span>
          </div>
          <span className="text-xs text-gray-600 truncate">
            {user?.firstName ?? user?.emailAddresses?.[0]?.emailAddress ?? 'User'}
          </span>
        </div>
        <button
          onClick={() => signOut({ redirectUrl: '/sign-in' })}
          className="flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-gray-600 hover:bg-gray-50 hover:text-black transition-colors w-full"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
