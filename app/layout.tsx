import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

// Why Inter: matches the reference design's clean, modern SaaS aesthetic.
// Inter is purpose-built for screen UIs — optimized for readability at small sizes,
// which matters for dense contact tables.
// Why --font-inter not --font-sans: globals.css has @theme inline { --font-sans: var(--font-sans) }
// which is circular. Using --font-inter as the Next.js variable breaks the cycle —
// globals.css then maps --font-sans → var(--font-inter) safely.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Luma CRM",
  description: "Community builder's intelligence layer over Luma event contacts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${inter.variable} h-full antialiased`}
        // inter.variable injects --font-inter onto the html element
      >
        {/* Why flex h-full: sidebar stays fixed height while main content scrolls independently */}
        <body className="flex h-full overflow-hidden bg-white">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </body>
      </html>
    </ClerkProvider>
  );
}
