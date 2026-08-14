'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/**
 * Atualização em tempo real dos painéis autenticados (RNF-08).
 *
 * Escuta mudanças em `tickets` via Supabase Realtime e dispara um
 * `router.refresh()` — o servidor recalcula as views agregadas e devolve o HTML
 * novo. Ou seja: o evento serve de GATILHO, não de fonte de dados. Aplicar o
 * payload do evento direto no cliente exigiria reimplementar no navegador o
 * cálculo de SLA e o score de fila que já existem no banco (ADR-004).
 *
 * O debounce existe porque uma rajada de tickets (importação, integração)
 * dispararia dezenas de refreshes por segundo.
 */
export function RealtimeRefresh({
  debounceMs = 1500,
  table = 'tickets',
}: {
  debounceMs?: number
  /** Tabela observada. `/mapas` observa `branches`: mudou o endereço, o mapa muda. */
  table?: 'tickets' | 'branches'
}) {
  const router = useRouter()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel(`${table}-changes`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => router.refresh(), debounceMs)
      })
      .subscribe()

    return () => {
      if (timer.current) clearTimeout(timer.current)
      supabase.removeChannel(channel)
    }
  }, [router, debounceMs, table])

  return null
}
