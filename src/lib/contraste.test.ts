import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * CONTRASTE DA PALETA — nos dois temas, token a token.
 *
 * DUAS RÉGUAS, E ELAS NÃO SÃO A MESMA
 * -----------------------------------
 * A WCAG 2.2 pede **4,5:1 para texto** (1.4.3) e **3:1 para componente e
 * contorno** (1.4.11). Tratar as duas como uma só erra nos dois sentidos:
 * medindo tudo por 4,5 reprova preenchimento que está certo, e medindo tudo por
 * 3 aprova texto que ninguém lê.
 *
 * Por isso este portão mede PARES, não cores soltas. Cor não tem contraste;
 * contraste é propriedade de um par — e o par só existe se alguém souber qual
 * token é escrito sobre qual. É isso que a tabela abaixo declara.
 *
 * POR QUE ISTO NÃO É TRABALHO DO `axe`
 * ------------------------------------
 * O `axe` mede a cor que o elemento ACABOU tendo no DOM. Se um `var()` estiver
 * errado e a cor vier herdada, ele aprova a cor herdada — o defeito atravessa.
 * E ele só vê o que a página está mostrando: o estado de erro, o vencido e o
 * vazio, que ninguém alcançou naquela execução, ficam sem medição.
 *
 * Aqui a medição é sobre a DEFINIÇÃO: todo par declarado é medido, nos dois
 * temas, tenha a tela daquele estado sido aberta ou não.
 *
 * O NÚMERO É O DA NORMA, NÃO O MEU
 * --------------------------------
 * A razão de contraste é a da WCAG: `(L1 + 0.05) / (L2 + 0.05)`, com L sendo a
 * luminância relativa de sRGB. Nada de aproximação por diferença de brilho.
 */

const CSS = readFileSync('src/app/globals.css', 'utf8')

/* ------------------------------------------------------------------------- */

type RGB = [number, number, number]

function hexParaRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const largo = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [
    parseInt(largo.slice(0, 2), 16),
    parseInt(largo.slice(2, 4), 16),
    parseInt(largo.slice(4, 6), 16),
  ]
}

/** Luminância relativa, WCAG 2.2 §Relative luminance. */
function luminancia([r, g, b]: RGB): number {
  const canal = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b)
}

function razao(a: string, b: string): number {
  const [la, lb] = [luminancia(hexParaRgb(a)), luminancia(hexParaRgb(b))]
  const [claro, escuro] = la > lb ? [la, lb] : [lb, la]
  return (claro + 0.05) / (escuro + 0.05)
}

/* ------------------------------------------------------------------------- */

/**
 * Lê uma paleta inteira.
 *
 * O tema claro é a definição BASE (a primeira de cada token no arquivo); o
 * escuro é a base com as redefinições do bloco `[data-tema='escuro']` por cima.
 * Essa ordem não é detalhe: um token que o escuro não redefine CONTINUA valendo
 * no escuro, e medir só o que o bloco escuro contém deixaria de fora justamente
 * os tokens que alguém esqueceu de redefinir — que são os que quebram.
 */
function paletas(): { claro: Record<string, string>; escuro: Record<string, string> } {
  const claro: Record<string, string> = {}
  for (const m of CSS.matchAll(/(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    if (!(m[1]! in claro)) claro[m[1]!] = m[2]!
  }

  const i = CSS.indexOf("[data-tema='escuro']")
  const bloco = CSS.slice(i, CSS.indexOf('\n  }', i))
  const escuro = { ...claro }
  for (const m of bloco.matchAll(/(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    escuro[m[1]!] = m[2]!
  }
  return { claro, escuro }
}

/**
 * Os pares, com a régua de cada um.
 *
 * `texto` = 4,5:1 (WCAG 1.4.3). `objeto` = 3:1 (WCAG 1.4.11): contorno de
 * campo, fio que delimita, preenchimento que precisa se distinguir do fundo.
 */
const PARES: [frente: string, fundo: string, regua: 'texto' | 'objeto', porque: string][] = [
  ['--color-ink', '--color-surface', 'texto', 'o texto corrente da aplicação'],
  ['--color-ink', '--color-surface-2', 'texto', 'o texto sobre o fundo da página'],
  ['--color-ink', '--color-surface-3', 'texto', 'o texto sobre cabeçalho de tabela'],
  ['--color-ink-2', '--color-surface', 'texto', 'o rótulo e o texto secundário'],
  ['--color-ink-2', '--color-surface-2', 'texto', 'idem, sobre o fundo da página'],
  ['--color-ink-3', '--color-surface', 'texto', 'a legenda e o texto de apoio'],
  ['--color-ink-3', '--color-surface-2', 'texto', 'idem, sobre o fundo da página'],

  ['--color-on-brand', '--color-brand', 'texto', 'o rótulo do botão primário'],
  ['--color-on-solid', '--color-danger-solid', 'texto', 'o rótulo do botão destrutivo'],
  ['--color-on-solid', '--color-ok-solid', 'texto', 'o rótulo do botão de confirmação'],
  ['--color-brand-ink', '--color-surface', 'texto', 'o link'],
  ['--color-brand-ink', '--color-brand-soft', 'texto', 'o texto dentro do aviso de marca'],

  /* O semáforo: cada tinta é lida sobre o próprio fundo tingido E sobre a
     superfície, porque as duas combinações existem na tela — a pílula e o
     número solto na tabela. */
  ['--color-ok-ink', '--color-ok-soft', 'texto', 'a pílula "dentro do prazo"'],
  ['--color-ok-ink', '--color-surface', 'texto', 'o mesmo texto sem pílula'],
  ['--color-warn-ink', '--color-warn-soft', 'texto', 'a pílula "em atenção"'],
  ['--color-warn-ink', '--color-surface', 'texto', 'o mesmo texto sem pílula'],
  ['--color-crit-ink', '--color-crit-soft', 'texto', 'a pílula "crítico"'],
  ['--color-crit-ink', '--color-surface', 'texto', 'o mesmo texto sem pílula'],
  ['--color-breach-ink', '--color-breach-soft', 'texto', 'a pílula "estourado"'],
  ['--color-breach-ink', '--color-surface', 'texto', 'o mesmo texto sem pílula'],
  ['--color-neutral-ink', '--color-neutral-soft', 'texto', 'a pílula neutra'],
  ['--color-neutral-ink', '--color-surface', 'texto', 'o mesmo texto sem pílula'],

  /* Contorno de campo: é o que faz o campo existir aos olhos de quem vai
     preenchê-lo, e por isso vale 1.4.11 e não a régua decorativa. */
  ['--color-border-strong', '--color-surface', 'objeto', 'o contorno do campo de formulário'],
  ['--color-border-strong', '--color-surface-2', 'objeto', 'idem, sobre o fundo da página'],
]

const REGUA = { texto: 4.5, objeto: 3 } as const

describe('contraste da paleta', () => {
  for (const tema of ['claro', 'escuro'] as const) {
    it(`todo par declarado passa na régua dele — tema ${tema}`, () => {
      const p = paletas()[tema]
      const reprovados: string[] = []

      for (const [frente, fundo, regua, porque] of PARES) {
        const a = p[frente]
        const b = p[fundo]
        /* Token que a paleta não tem é falha do portão, não aprovação dele:
           sem isto, renomear um token faria o par sumir em silêncio. */
        expect(a, `${frente} não existe na paleta ${tema}`).toBeTruthy()
        expect(b, `${fundo} não existe na paleta ${tema}`).toBeTruthy()

        const r = razao(a!, b!)
        if (r < REGUA[regua]) {
          reprovados.push(
            `${frente} sobre ${fundo} = ${r.toFixed(2)}:1 ` +
              `(precisa ${REGUA[regua]}:1 — ${porque})`,
          )
        }
      }

      expect(reprovados, `pares ilegíveis no tema ${tema}`).toEqual([])
    })
  }

  it('as duas paletas estão completas e são diferentes', () => {
    /*
     * Guarda contra vacuidade, em três frentes:
     *  · a paleta clara leu tokens de verdade;
     *  · a escura também — se o bloco `[data-tema='escuro']` mudar de seletor,
     *    `escuro` vira cópia de `claro` e as duas suítes medem a mesma coisa
     *    duas vezes, passando;
     *  · e a tabela de pares não ficou vazia.
     */
    const { claro, escuro } = paletas()
    expect(Object.keys(claro).length, 'nenhum token lido').toBeGreaterThan(20)
    const redefinidos = Object.keys(escuro).filter((k) => escuro[k] !== claro[k])
    expect(
      redefinidos.length,
      'o tema escuro não redefiniu token nenhum — o seletor do bloco mudou?',
    ).toBeGreaterThan(10)
    expect(PARES.length).toBeGreaterThan(15)
  })
})
