import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Why Clerk over NextAuth: faster setup, built-in App Router support,
// no DB session table needed, managed token rotation out of the box.
//
// Why proxy.ts not middleware.ts: Next.js 16 deprecated middleware in
// favour of the proxy convention. Same functionality, new filename.

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/cron(.*)',
  // Why public: Vercel cron triggers these via HTTP GET with no user session.
  // Auth is handled inside each cron route by verifying CRON_SECRET instead.
])

export default clerkMiddleware(async (auth, req) => {
  // Protect all routes except sign-in/sign-up
  if (!isPublicRoute(req)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    // Run on all routes except static files and Next.js internals
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
