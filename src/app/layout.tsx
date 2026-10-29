import type { Metadata, Viewport } from 'next'

/* As fontes, dos pacotes — uma linha por peso e por subconjunto. Ver o bloco
   abaixo para o porquê de não ser `next/font/google`. */
import '@fontsource-variable/space-grotesk/wght.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-700.css'
import '@fontsource/ibm-plex-sans/latin-ext-400.css'
import '@fontsource/ibm-plex-sans/latin-ext-500.css'
import '@fontsource/ibm-plex-sans/latin-ext-600.css'
import '@fontsource/ibm-plex-sans/latin-ext-700.css'

import './globals.css'
import { TEMA_INLINE_SCRIPT } from '@/components/theme-toggle'

/**
 * Duas famílias, com papéis distintos — e nenhuma delas é a fonte do sistema.
 *
 * **Space Grotesk** no display. É um grotesco de desenho próprio: o `g` de
 * perna única, o `1` com serifa, números de largura fixa. Isso importa aqui mais
 * que estética — metade desta aplicação é número grande (saldo, contagem de
 * ticket, painel de TV a cinco metros), e algarismo tabular é o que impede a
 * coluna de dançar a cada atualização em tempo real.
 *
 * **IBM Plex Sans** no corpo. Foi desenhada para interface técnica densa: abre
 * bem em 12–14px, distingue `l`/`I`/`1` e `0`/`O` — que numa tela de patrimônio
 * e número de série é diferença entre ler certo e abrir chamado errado.
 *
 * O que saiu: `system-ui, …, Roboto, …, Arial`. A pilha do sistema dava três
 * aparências diferentes em Windows, macOS e Android para a mesma tela, e nenhuma
 * delas era uma decisão.
 *
 * `font-display: swap` é deliberado — e vem dos próprios `@font-face` dos
 * pacotes: o texto aparece na fonte de fallback e troca quando a web font
 * chega. A alternativa (`block`) esconderia o conteúdo por até três segundos
 * numa tela de operação.
 *
 * ## Por que NÃO é `next/font/google`
 *
 * Porque ele baixa as fontes **em tempo de build**. Numa máquina com internet
 * aberta isso é invisível; atrás de um proxy que reescreve TLS, ou num CI sem
 * saída, o build morre em `Failed to fetch Space Grotesk from Google Fonts` —
 * e esse erro não parece problema de rede para quem o encontra, parece defeito
 * do projeto. Foi exatamente assim que o primeiro `docker compose build` falhou.
 *
 * Os pacotes `@fontsource*` trazem os mesmos arquivos `.woff2` do Google, pela
 * mesma licença (SIL OFL 1.1), dentro do `node_modules`. O build deixa de
 * depender de rede, o `package-lock.json` passa a fixar a VERSÃO da fonte — e
 * nada sai desta aplicação para o Google quando alguém abre uma tela, que é um
 * efeito colateral bem-vindo num produto que atende cliente de terceiro.
 *
 * O que se perde: o `size-adjust` que o `next/font` calcula para a fonte de
 * fallback, que reduz o pulo de layout na troca. É um pulo pequeno, de uma vez
 * por visita, e o preço de um build que não funciona é maior.
 *
 * As famílias se chamam `IBM Plex Sans` e `Space Grotesk Variable`, e os nomes
 * estão em `globals.css`, nas duas variáveis `-raw` — o mesmo contrato de
 * antes, para o resto do CSS não mudar nada.
 *
 * Os imports listam peso por peso e subconjunto por subconjunto de propósito:
 * importar `400.css` traria cirílico, grego e vietnamita junto, e são arquivos
 * que o produto nunca pede.
 */

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
  /*
   * Uma cor por esquema: sem isso a barra do navegador no celular fica azul
   * clara sobre uma aplicação escura, que é a emenda pior que o soneto.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#1d4ed8' },
    { media: '(prefers-color-scheme: dark)', color: '#0c1016' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/*
         * Este script roda ANTES da primeira pintura, e é a única forma de o
         * tema escolhido não chegar depois de um lampejo branco. Precisa ser
         * síncrono e inline: qualquer outra coisa — efeito, componente, arquivo
         * externo — acontece tarde demais e a tela pisca.
         *
         * `suppressHydrationWarning` no <html> acompanha: o atributo que o
         * script escreve não existe no HTML do servidor, e sem isso o React
         * reclamaria de uma divergência que é justamente o objetivo.
         */}
        <script dangerouslySetInnerHTML={{ __html: TEMA_INLINE_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
