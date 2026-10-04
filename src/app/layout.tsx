import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans, Space_Grotesk } from 'next/font/google'
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
 * `display: 'swap'` é deliberado: o texto aparece na fonte de fallback e troca
 * quando a web font chega. A alternativa (`block`) esconderia o conteúdo por até
 * três segundos numa tela de operação.
 */
const display = Space_Grotesk({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-display-raw',
})

const corpo = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans-raw',
})

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
    <html lang="pt-BR" className={`${display.variable} ${corpo.variable}`} suppressHydrationWarning>
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
