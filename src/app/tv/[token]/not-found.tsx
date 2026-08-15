import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Painel indisponível',
  robots: { index: false, follow: false },
}

/**
 * 404 específico do painel de TV — sobrepõe o 404 padrão do Next (em inglês,
 * fundo branco) só para as rotas dentro de `/tv/[token]`.
 *
 * Uma TV de parede não tem quem leia console de erro: sem isso, um token
 * revogado ou expirado virava "404 | This page could not be found." em texto
 * pequeno e preto no branco, numa sala calibrada para o painel escuro — e
 * ficava assim indefinidamente, porque `TvBoard` (e o intervalo que chama
 * `router.refresh()`) nunca chega a montar quando a rota cai em 404.
 */
export default function TvTokenNotFound() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--color-tv-bg)] px-8 text-center text-[var(--color-tv-ink)]">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--color-tv-warn)]">
        Painel de TV
      </p>
      <h1 className="text-3xl font-bold">Este painel não está mais disponível</h1>
      <p className="max-w-xl text-base text-[var(--color-tv-ink-2)]">
        O token de exibição deste endereço é inválido, expirou ou foi revogado. Isso não se
        resolve sozinho — peça a um administrador para gerar um novo painel de TV e abrir o
        endereço novo nesta tela.
      </p>
    </div>
  )
}
