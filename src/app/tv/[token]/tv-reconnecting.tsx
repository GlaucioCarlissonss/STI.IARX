'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Estado transitório: a consulta que resolve o token falhou (rede, banco),
 * não que o token seja inválido. Sem essa distinção, uma falha passageira
 * derrubava o painel no MESMO 404 permanente de um token revogado — e a TV
 * nunca se recuperava sozinha, porque `TvBoard` (dono do intervalo de
 * atualização) nunca chega a montar quando a página cai em 404.
 *
 * Aqui o intervalo de nova tentativa já nasce montado: assim que a consulta
 * voltar a funcionar, `router.refresh()` re-renderiza a página com os dados
 * de verdade, substituindo esta tela pelo painel — sem ninguém precisar
 * subir numa cadeira para mexer na TV.
 */
export function TvReconnecting() {
  const router = useRouter()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 15000)
    return () => clearInterval(id)
  }, [router])

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--color-tv-bg)] px-8 text-center text-[var(--color-tv-ink)]">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--color-tv-warn)]">
        Painel de TV
      </p>
      <h1 className="text-3xl font-bold">Reconectando…</h1>
      <p className="max-w-xl text-base text-[var(--color-tv-ink-2)]">
        Não foi possível falar com o servidor agora. O painel tenta de novo automaticamente a
        cada 15 segundos — nada precisa ser feito aqui.
      </p>
    </div>
  )
}
