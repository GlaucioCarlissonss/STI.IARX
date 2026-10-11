import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A regra do briefing — "mensagens de erro claras e acionáveis, **sem expor
 * detalhes técnicos internos**" — vale para a aplicação inteira, e não só para
 * o tradutor.
 *
 * A entrega 5 corrigiu `mensagemDeErro` e a tela de erro. A entrega 7 descobriu
 * que isso tinha consertado o tradutor e deixado os CHAMADORES de fora:
 * **63 lugares** devolviam `error.message` cru para a tela, contra 12 que
 * usavam o tradutor. A regra existia, a ferramenta existia, e cinco de cada seis
 * ações não a usavam.
 *
 * Esse tipo de divergência não aparece em nenhum outro teste, porque nada
 * quebra: a tela funciona e passa a contar coisa demais. Este arquivo é a
 * guarda que impede a próxima linha de `return { error: error.message }` de
 * entrar sem ninguém ver.
 */

function arquivosDe(raiz: string, extensoes = ['.ts', '.tsx']): string[] {
  const achados: string[] = []
  for (const nome of readdirSync(raiz)) {
    const caminho = join(raiz, nome)
    if (statSync(caminho).isDirectory()) achados.push(...arquivosDe(caminho, extensoes))
    else if (extensoes.some((e) => nome.endsWith(e))) achados.push(caminho)
  }
  return achados
}

const RAIZ = join(process.cwd(), 'src/app')

/**
 * O que caracteriza um vazamento: `error.message` dentro de algo que **volta
 * para quem usa** — um `return`, ou o campo `error:` de um `ActionState`.
 *
 * O que não é vazamento, e por isso não é marcado:
 *   · `console.error(..., error.message)` — vai para o log do servidor, que é
 *     exatamente onde o texto cru serve;
 *   · `/alguma coisa/.test(error.message)` — está INSPECIONANDO a mensagem para
 *     escolher uma frase em português, que é o comportamento certo.
 */
const VAZAMENTO = /(return\s[^\n]*|error:\s*)error(\?)?\.message/

/**
 * Linha de comentário não é código.
 *
 * A primeira versão desta varredura marcou o comentário que EXPLICA o defeito
 * removido em `filas/actions.ts` — ele cita `return error.message` entre
 * crases. Um teste que proíbe descrever o problema que acabou de ser corrigido
 * empurra a próxima pessoa a apagar a explicação em vez do defeito.
 */
const COMENTARIO = /^\s*(\*|\/\/|\/\*)/

describe('nenhuma ação devolve a mensagem crua do banco', () => {
  const suspeitos: string[] = []

  for (const arquivo of arquivosDe(RAIZ)) {
    const linhas = readFileSync(arquivo, 'utf8').split('\n')
    linhas.forEach((linha, i) => {
      if (!COMENTARIO.test(linha) && VAZAMENTO.test(linha)) {
        suspeitos.push(`${arquivo.replace(process.cwd() + '/', '')}:${i + 1}  ${linha.trim()}`)
      }
    })
  }

  it('nem em Server Action, nem em página', () => {
    expect(
      suspeitos,
      `use mensagemDeErro() ou mensagemDeAuth():\n${suspeitos.join('\n')}`,
    ).toEqual([])
  })

  it('e a varredura está de fato olhando para os arquivos certos', () => {
    /*
     * Sem esta segunda asserção, um erro no caminho faria a primeira passar com
     * zero arquivos lidos — um teste verde que não testa nada é pior que teste
     * nenhum, porque dá a impressão de cobertura.
     */
    const arquivos = arquivosDe(RAIZ)
    expect(arquivos.length).toBeGreaterThan(50)
    expect(arquivos.some((f) => f.endsWith('actions.ts'))).toBe(true)
  })
})
