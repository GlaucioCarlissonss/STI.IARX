/*
 * Gera os ícones PNG do PWA a partir de `src/app/icon.svg`.
 *
 * POR QUE UM SCRIPT, E NÃO ARQUIVOS COMITADOS À MÃO
 * -------------------------------------------------
 * Porque o monograma é o mesmo do resto do sistema, e dois arquivos que deveriam
 * ser a mesma coisa divergem no dia em que alguém muda um. Aqui o SVG é a fonte
 * e os PNGs são derivados — regerar é um comando.
 *
 * POR QUE PLAYWRIGHT, E NÃO UMA BIBLIOTECA DE IMAGEM
 * --------------------------------------------------
 * Porque ele já está instalado para as suítes de navegador, e o que se pede aqui
 * é exatamente o que um navegador faz melhor que qualquer conversor: renderizar
 * SVG com as mesmas regras de quem vai exibir o resultado. Uma dependência nova
 * para isso seria uma dependência a mais para auditar.
 *
 * A VERSÃO `maskable`
 * -------------------
 * Android recorta o ícone num formato que varia por fabricante — círculo,
 * quadrado arredondado, gota. A especificação reserva 20% de margem em cada
 * lado para esse recorte; sem ela o monograma aparece cortado em metade dos
 * aparelhos. Por isso são dois desenhos, e não um redimensionado.
 *
 * Uso: node scripts/gerar-icones-pwa.mjs
 */
import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const DESTINO = join(RAIZ, 'public', 'icones')

const svg = await readFile(join(RAIZ, 'src', 'app', 'icon.svg'), 'utf8')
await mkdir(DESTINO, { recursive: true })

const navegador = await chromium.launch()

/** Desenha o SVG num quadrado de `lado`, com `margem` de folga proporcional. */
async function gerar(nome, lado, margem) {
  const pagina = await navegador.newPage({
    viewport: { width: lado, height: lado },
    deviceScaleFactor: 1,
  })
  const interno = Math.round(lado * (1 - margem * 2))
  await pagina.setContent(
    `<style>
       html,body{margin:0;height:100%}
       body{display:grid;place-items:center;background:#1d4ed8}
       svg{width:${interno}px;height:${interno}px}
       /* O fundo do próprio SVG some: quem pinta o quadrado é o body, senão o
          cantinho arredondado dele apareceria dentro do recorte do Android. */
       svg > rect:first-of-type{display:none}
     </style>${svg}`,
  )
  const buffer = await pagina.screenshot({ omitBackground: false })
  await writeFile(join(DESTINO, nome), buffer)
  await pagina.close()
  console.log(`  ${nome} (${lado}×${lado})`)
}

console.log('Gerando ícones em public/icones:')
await gerar('icone-192.png', 192, 0.12)
await gerar('icone-512.png', 512, 0.12)
await gerar('icone-maskable-512.png', 512, 0.2)

await navegador.close()
