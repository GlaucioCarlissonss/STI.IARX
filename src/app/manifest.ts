import type { MetadataRoute } from 'next'

/**
 * O manifesto que torna o portal instalável (LG-08).
 *
 * ## O que isto muda, e o que não muda
 *
 * Não muda **nada** do que o solicitante consegue fazer: abrir chamado,
 * acompanhar, avaliar. Muda **onde** ele faz. Instalado, o portal abre num ícone
 * na tela inicial, sem barra de endereço, e volta a abrir depois de fechado sem
 * precisar lembrar a URL — que é o atrito real de quem usa o portal uma vez por
 * mês, quando o computador para.
 *
 * ## `start_url` é `/portal`, e não `/`
 *
 * Porque quem instala isto é o solicitante. A raiz leva ao painel operacional,
 * que ele não alcança — e abrir um aplicativo recém-instalado numa tela de
 * "sem permissão" é a pior primeira impressão possível. Quem trabalha no sistema
 * inteiro usa o navegador, onde a barra de endereço serve para alguma coisa.
 *
 * ## Dois ícones, e não um redimensionado
 *
 * O Android recorta o ícone num formato que varia por fabricante — círculo,
 * quadrado arredondado, gota. O `maskable` reserva 20% de margem para esse
 * recorte; sem ele o monograma aparece cortado em metade dos aparelhos. Os dois
 * saem do mesmo SVG, por `scripts/gerar-icones-pwa.mjs`.
 *
 * ## Por que não há `screenshots` nem `shortcuts`
 *
 * `screenshots` serve à vitrine de instalação do Chrome no Android; capturas de
 * um sistema multi-tenant mostrariam dado de um cliente para todos os outros.
 * `shortcuts` levaria a telas que dependem de permissão, e atalho que leva a
 * "sem acesso" é pior que atalho nenhum.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'STI — Portal do solicitante',
    short_name: 'STI Portal',
    description:
      'Abra um chamado, acompanhe o andamento e avalie o atendimento.',
    start_url: '/portal',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'pt-BR',
    dir: 'ltr',
    /* As mesmas cores dos tokens de `globals.css`: a barra do sistema combina
       com a aplicação em vez de brigar com ela. */
    background_color: '#f6f7f9',
    theme_color: '#1d4ed8',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icones/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icones/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icones/icone-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
