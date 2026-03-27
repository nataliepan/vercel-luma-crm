import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <nav className="border-b px-6 py-3 flex items-center gap-6 text-sm">
            <span className="font-semibold">Luma CRM</span>
            <a href="/contacts" className="text-gray-600 hover:text-black">Contacts</a>
            <a href="/import" className="text-gray-600 hover:text-black">Import</a>
          </nav>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
