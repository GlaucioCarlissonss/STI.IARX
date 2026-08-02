import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'STI · Helpdesk e Gestão de TI',
    template: '%s · STI',
  },
  description:
    'Plataforma SaaS de helpdesk e gestão de TI: tickets, SLA, filas, inventário e integrações.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1d4ed8',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
