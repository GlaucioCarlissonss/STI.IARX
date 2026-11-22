import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * O MANUAL E AS IMAGENS DELE NÃO DIVERGEM.
 *
 * Por que isto precisa de portão
 * ------------------------------
 * Manual com imagem quebrada é pior que manual sem imagem: o leitor vê o
 * quadrado vazio e conclui que o sistema está quebrado, não o documento. E o
 * contrário — captura que ninguém cita — é tela que foi fotografada, pesa no
 * repositório e não documenta nada.
 *
 * Nenhum dos dois produz erro. É a mesma classe de defeito que já pegou esta
 * base quatro vezes: o menu do protótipo 26 telas atrás, o "Mapa do menu" com
 * telas sem destino, a varredura sem a `/assinatura`, e cinco botões
 * `Abrir ›` apontando para arquivos que nunca existiram.
 *
 * A TERCEIRA ASSERÇÃO é a que importa de verdade: a lista de capturas do
 * roteiro, o conjunto de arquivos no disco e as citações do manual têm de ser
 * a mesma coisa. Sem ela, acrescentar uma captura ao roteiro e esquecer de
 * citá-la passaria — e a tela nova ficaria fora do manual sem ninguém notar,
 * que é exatamente como o protótipo ficou 26 telas atrás.
 */

const MANUAL = 'docs/27-manual-do-usuario.md'
const PASTA = 'docs/manual'
const ROTEIRO = 'scripts/capturar-manual.mjs'

const TEXTO = readFileSync(MANUAL, 'utf8')

/** As imagens que o manual CITA, na forma `![alt](manual/arquivo.webp)`. */
function citadas(): string[] {
  return [...TEXTO.matchAll(/!\[[^\]]*\]\(manual\/([^)]+)\)/g)].map((m) => m[1]!)
}

/** As imagens que existem no disco. */
function noDisco(): string[] {
  return readdirSync(PASTA).filter((f) => f.endsWith('.webp')).sort()
}

/** Os nomes que o roteiro de captura declara. */
function noRoteiro(): string[] {
  const fonte = readFileSync(ROTEIRO, 'utf8')
  return [...fonte.matchAll(/\bnome:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]! + '.webp').sort()
}

describe('manual do usuário × as imagens dele', () => {
  it('toda imagem citada no manual existe no disco', () => {
    const faltando = citadas().filter((f) => !existsSync(join(PASTA, f)))
    expect(
      faltando,
      'o manual aponta para estas imagens e elas não estão em `docs/manual/` — ' +
        'quem lê vê o quadrado vazio e conclui que o SISTEMA está quebrado',
    ).toEqual([])
  })

  it('toda imagem no disco é citada no manual', () => {
    const cit = new Set(citadas())
    const sobrando = noDisco().filter((f) => !cit.has(f))
    expect(
      sobrando,
      'estas capturas existem e o manual não as usa: peso no repositório sem ' +
        'documentar nada, ou — pior — uma tela que foi fotografada e esquecida',
    ).toEqual([])
  })

  it('o roteiro de captura, o disco e o manual falam das mesmas telas', () => {
    const roteiro = noRoteiro()
    const disco = noDisco()
    expect(
      roteiro.filter((f) => !disco.includes(f)),
      'o roteiro declara estas capturas e elas não foram geradas — rode ' +
        '`node scripts/capturar-manual.mjs` e converta',
    ).toEqual([])
    expect(
      disco.filter((f) => !roteiro.includes(f)),
      'estas imagens não vêm do roteiro: foram postas à mão e ninguém as refaz ' +
        'quando a tela mudar',
    ).toEqual([])
  })

  it('a peneira enxerga alguma coisa', () => {
    /*
     * Guarda contra vacuidade. Se a expressão parar de casar — um `!` trocado,
     * uma pasta renomeada — as três listas ficam vazias, as diferenças entre
     * elas ficam vazias, e as asserções acima passam para sempre sem ler uma
     * linha.
     */
    expect(citadas().length, 'nenhuma imagem citada no manual').toBeGreaterThan(20)
    expect(noDisco().length, 'nenhuma imagem em docs/manual/').toBeGreaterThan(20)
    expect(noRoteiro().length, 'nenhum nome lido do roteiro de captura').toBeGreaterThan(20)
  })
})
