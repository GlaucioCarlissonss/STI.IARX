'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Route } from 'next'
import type { ReactNode } from 'react'

/**
 * Link de navegação com estado ativo.
 *
 * `aria-current="page"` é o que comunica a posição atual para leitores de tela
 * — o destaque visual sozinho não informa nada a quem não enxerga a tela.
 */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname()
  const isActive = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href as Route}
      aria-current={isActive ? 'page' : undefined}
      className={`block whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        isActive
          ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand-ink)]'
          : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-3)]'
      }`}
    >
      {children}
    </Link>
  )
}
