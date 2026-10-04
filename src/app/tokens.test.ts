import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Contraste da paleta, medido — não prometido.
 *
 * O briefing pede AA. AA conferido uma vez, à mão, no dia da entrega, dura até
 * a primeira pessoa clarear um cinza porque "ficou melhor assim". E o sintoma
 * de uma falha aqui não é um erro: é alguém com baixa visão, num monitor pior
 * que o nosso, que simplesmente não consegue ler a dica do campo — e não
 * reporta, porque pensa que o problema é a vista dele.
 *
 * Então o teste lê `globals.css` e aplica a fórmula da WCAG 2.1 às combinações
 * que a aplicação REALMENTE produz, nos dois temas. Nenhuma lista de cores
 * escrita à mão aqui: se a paleta mudar e o arquivo não, o teste mede a paleta
 * nova.
 *
 * Os dois alvos:
 *   4.5:1  texto normal (1.4.3)
 *   3.0:1  contorno de componente de interface (1.4.11)
 */

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')

/**
 * Lê os tokens de cor de um bloco.
 *
 * O tema escuro aparece DUAS vezes no arquivo — uma para a escolha explícita
 * (`[data-tema='escuro']`) e outra para quem segue o sistema. Ler pelo primeiro
 * seletor e exigir que o segundo seja idêntico é o que impede os dois
 * divergirem, que é o defeito clássico desse arranjo: o botão passa a produzir
 * uma aparência e a preferência do sistema, outra.
 */
function tokensDe(seletor: string): Record<string, string> {
  const inicio = css.indexOf(seletor)
  if (inicio < 0) throw new Error(`seletor ${seletor} não existe em globals.css`)
  const abre = css.indexOf('{', inicio)
  // Nenhum dos três blocos tem chave aninhada, então a primeira `}` é o fim.
  const bloco = css.slice(abre, css.indexOf('}', abre))
  const tokens: Record<string, string> = {}
  for (const m of bloco.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[m[1]!] = m[2]!.toLowerCase()
  }
  return tokens
}

const claro = tokensDe('@theme {')
const escuroExplicito = tokensDe("[data-tema='escuro'] {")
const escuroDoSistema = tokensDe(":root:not([data-tema='claro']) {")

/** O tema escuro só redefine parte dos tokens; o resto continua vindo do claro. */
const escuro = { ...claro, ...escuroExplicito }

function canal(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminancia(hex: string): number {
  const n = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => canal(parseInt(n.slice(i, i + 2), 16))) as [
    number,
    number,
    number,
  ]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** As combinações que as telas produzem, não todas as combinações possíveis. */
const SEMAFORO = ['ok', 'warn', 'crit', 'breach', 'neutral'] as const

const CASOS: { frente: string; fundo: string; alvo: number; nota: string }[] = [
  ...['ink', 'ink-2', 'ink-3', 'brand', 'brand-ink'].flatMap((frente) =>
    ['surface', 'surface-2'].map((fundo) => ({
      frente,
      fundo,
      alvo: 4.5,
      nota: 'texto sobre superfície',
    })),
  ),
  ...SEMAFORO.flatMap((s) => [
    { frente: `${s}-ink`, fundo: `${s}-soft`, alvo: 4.5, nota: 'selo do semáforo' },
    { frente: `${s}-ink`, fundo: 'surface', alvo: 4.5, nota: 'valor colorido no cartão' },
  ]),
  { frente: 'brand-ink', fundo: 'brand-soft', alvo: 4.5, nota: 'item ativo do menu' },
  { frente: 'on-brand', fundo: 'brand', alvo: 4.5, nota: 'botão primário' },
  { frente: 'on-brand', fundo: 'brand-ink', alvo: 4.5, nota: 'botão primário em hover' },
  { frente: 'on-solid', fundo: 'danger-solid', alvo: 4.5, nota: 'botão destrutivo' },
  { frente: 'on-solid', fundo: 'ok-solid', alvo: 4.5, nota: 'botão de confirmação' },
  { frente: 'border-strong', fundo: 'surface', alvo: 3, nota: 'contorno de campo' },
  { frente: 'border-strong', fundo: 'surface-2', alvo: 3, nota: 'contorno de campo' },
  { frente: 'brand', fundo: 'surface', alvo: 3, nota: 'anel de foco' },
]

describe.each([
  ['tema claro', claro],
  ['tema escuro', escuro],
])('%s', (_nome, paleta) => {
  it.each(CASOS)('$frente sobre $fundo ≥ $alvo:1 — $nota', ({ frente, fundo, alvo }) => {
    const a = paleta[frente]
    const b = paleta[fundo]
    expect(a, `token --color-${frente} não existe`).toBeTruthy()
    expect(b, `token --color-${fundo} não existe`).toBeTruthy()
    expect(contraste(a!, b!)).toBeGreaterThanOrEqual(alvo)
  })
})

describe('as duas portas do tema escuro', () => {
  it('a escolha explícita e a preferência do sistema definem a MESMA paleta', () => {
    expect(escuroDoSistema).toEqual(escuroExplicito)
  })

  it('o tema escuro redefine toda cor de superfície, tinta e semáforo', () => {
    /*
     * Esquecer UM token no bloco escuro é o defeito mais provável desta
     * estrutura, e o mais silencioso: o token esquecido mantém o valor claro e
     * vira uma mancha branca no meio da tela escura — ou texto cinza-claro
     * sobre fundo branco, que é pior.
     */
    const precisamMudar = [
      'surface',
      'surface-2',
      'surface-3',
      'border',
      'border-strong',
      'ink',
      'ink-2',
      'ink-3',
      'brand',
      'brand-ink',
      'brand-soft',
      'on-brand',
      'danger-solid',
      'ok-solid',
      ...SEMAFORO.flatMap((s) => [`${s}-ink`, `${s}-soft`]),
    ]
    const faltando = precisamMudar.filter((t) => !(t in escuroExplicito))
    expect(faltando, `sem valor no tema escuro: ${faltando.join(', ')}`).toEqual([])
  })

  /*
   * Esta é a asserção que protege o caso mais fácil de quebrar sem perceber:
   * alguém num computador configurado em modo escuro clica em "claro" e nada
   * acontece, porque a media query venceu a escolha explícita. O botão existiria
   * e não faria nada — e num teste manual feito num monitor claro isso NUNCA
   * aparece.
   */
  it("a preferência do sistema cede à escolha explícita de 'claro'", () => {
    const media = css.indexOf('@media (prefers-color-scheme: dark)')
    expect(media).toBeGreaterThan(0)
    const seletor = css.slice(media, css.indexOf('{', css.indexOf('{', media) + 1))
    expect(seletor).toContain(":root:not([data-tema='claro'])")
  })

  /*
   * O painel de TV fica numa parede, ligado o dia inteiro, e quem o vê não tem
   * teclado. Se um token que muda com o tema entrar ali, a tela vira BRANCA
   * assim que o navegador daquele computador estiver em modo claro — e ninguém
   * no escritório vai saber o que aconteceu nem como desfazer. Por isso a tela
   * usa apenas `--color-tv-*`, que não têm variante clara, e por isso isto é
   * verificado em vez de combinado.
   */
  it('a tela de TV não usa nenhum token que mude com o tema', () => {
    const dir = join(process.cwd(), 'src/app/tv/[token]')
    const usados = new Set<string>()
    for (const arquivo of readdirSync(dir)) {
      const fonte = readFileSync(join(dir, arquivo), 'utf8')
      for (const m of fonte.matchAll(/var\(--color-([a-z0-9-]+)\)/g)) usados.add(m[1]!)
    }
    expect(usados.size).toBeGreaterThan(0)
    const temaveis = [...usados].filter((t) => !t.startsWith('tv-'))
    expect(temaveis, `tokens sensíveis ao tema na TV: ${temaveis.join(', ')}`).toEqual([])
  })

  it('o pino do mapa NÃO muda com o tema — ele é lido sobre o mapa, que não escurece', () => {
    for (const m of ['marker-green', 'marker-amber', 'marker-red']) {
      expect(claro[m]).toBeTruthy()
      expect(escuroExplicito[m]).toBeUndefined()
    }
  })
})
