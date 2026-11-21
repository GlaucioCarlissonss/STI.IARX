/*
 * REFLUXO EM 320px — nenhuma tela rola para o lado.
 *
 * O que se mede, e por que é 320
 * ------------------------------
 * 320 CSS px é o critério 1.4.10 da WCAG 2.2: o conteúdo tem de caber em 320px
 * de largura sem exigir rolagem em DOIS eixos. Rolar para baixo é esperado;
 * rolar para o lado para ler uma frase é o que o critério proíbe, e é também o
 * que torna a tela inutilizável em celular pequeno.
 *
 * O defeito que este portão impede é cumulativo: cada barra nova, cada coluna
 * nova, cada grupo de botões empurra um pouco a largura. Ninguém introduz
 * rolagem lateral de propósito — ela aparece na soma, três entregas depois, e
 * quem a introduziu não está mais olhando.
 *
 * O fato, e não o proxy
 * ---------------------
 * O que se mede é `scrollWidth > clientWidth` no ELEMENTO RAIZ. Medir a largura
 * de um componente suspeito mediria o suspeito, não o sintoma; e `window`
 * mentiria, porque a barra de rolagem do navegador entra na conta.
 *
 * A tolerância de 1px não é folga: é o arredondamento de subpixel do próprio
 * motor de layout, que devolve 320.5 onde a tela tem 320.
 *
 * A EXCEÇÃO LEGÍTIMA é o contêiner com `overflow-x: auto` — tabela larga,
 * diagrama, bloco de código. Ele rola DENTRO de si e a página não rola: por
 * isso a medição é na raiz, e não na soma dos filhos. Uma tabela que estoura a
 * raiz é tabela sem o contêiner, e aí o vermelho é merecido.
 *
 * Como rodar
 * ----------
 *   bash scripts/preparar-banco-local.sh
 *   npm run build && npx next start -p 3177 &
 *   node demo/tests/local/refluxo.spec.mjs
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3177'

/* As mesmas rotas de `telas.spec.mjs`, lidas de lá: duas listas da mesma coisa
   divergiriam, e a que ficasse para trás mediria menos sem avisar. */
const { ROTAS } = await import('./rotas.mjs')

/* O motor devolve 320.5 onde a tela tem 320 — arredondamento de subpixel, não
   estouro. Acima disso é largura de verdade. */
const TOLERANCIA = 1

const b = await chromium.launch()
const ctx = await b.newContext({
  viewport: { width: 320, height: 720 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
})
const p = await ctx.newPage()

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await p.fill('input[name="email"]', process.env.USUARIO ?? 'admin@iaroffice.com.br')
await p.fill('input[name="password"]', 'desenvolvimento')
await p.click('form button[type="submit"]')
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })

const estouros = []
let conferidas = 0

for (const rota of ROTAS) {
  await p.goto(BASE + rota, { waitUntil: 'networkidle' }).catch(() => null)
  /* Esperar a animação de entrada terminar: medir no meio do fade mede uma
     largura que não existe em nenhum quadro parado. */
  await p.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  )

  const m = await p.evaluate(() => {
    const raiz = document.documentElement
    const sobra = raiz.scrollWidth - raiz.clientWidth
    if (sobra <= 1) return { sobra, culpado: null }
    /*
     * Quem é mais largo que a raiz e NÃO rola dentro de si.
     *
     * Duas exclusões, e as duas custaram uma acusação errada na prova de
     * falsificação deste portão:
     *
     *  · `position: fixed` e `sticky` ACOMPANHAM a largura de rolagem quando ela
     *    cresce — uma barra `inset-x-0` passa a medir 900px porque a página
     *    passou a medir 900px. Ela é sintoma, nunca causa, e foi exatamente ela
     *    que o portão apontou da primeira vez;
     *  · `overflow-x` em `auto`/`scroll`/`hidden` é o contêiner que rola dentro
     *    de si — tabela larga, diagrama. É o padrão certo, não o defeito.
     *
     * E o relato é do MAIS LARGO, não do primeiro encontrado: a ordem do DOM
     * não diz nada sobre quem empurrou a página, e mandar quem for consertar
     * para o primeiro elemento da árvore é mandá-lo para o lugar errado.
     */
    const largura = raiz.clientWidth
    const suspeitos = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width <= largura + 1 && r.right <= largura + 1) continue
      const s = getComputedStyle(el)
      if (s.position === 'fixed' || s.position === 'sticky') continue
      if (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') continue
      suspeitos.push({ el, largura: r.width })
    }
    if (!suspeitos.length) return { sobra, culpado: '(nenhum filho isolado — a soma de vários)' }
    suspeitos.sort((a, b) => b.largura - a.largura)
    const { el, largura: w } = suspeitos[0]
    return {
      sobra,
      culpado: `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} — ${Math.round(w)}px`,
    }
  })

  conferidas += 1
  if (m.sobra > TOLERANCIA) {
    estouros.push({ rota, ...m })
    console.log(`FALHOU ${rota}  +${Math.round(m.sobra)}px  ${m.culpado ?? ''}`)
  } else {
    console.log(`  ok   ${rota}`)
  }
}

/* Guarda contra vacuidade: se a lista de rotas sumir, o laço não roda e o
   relatório sai "0 com problema" — indistinguível de aprovação. */
if (conferidas < 10) {
  console.log(`\nFALHOU: só ${conferidas} rota(s) conferida(s) — a lista sumiu?`)
  await b.close()
  process.exit(1)
}

console.log(`\n${estouros.length} rota(s) com rolagem lateral de ${conferidas}.`)
for (const e of estouros) console.log(`  ${e.rota}: +${Math.round(e.sobra)}px — ${e.culpado}`)

await b.close()
process.exit(estouros.length === 0 ? 0 : 1)
