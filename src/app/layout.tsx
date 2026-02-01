import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Le Chat Local',
  description: 'Local AI chat powered by LM Studio',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}
