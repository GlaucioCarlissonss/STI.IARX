import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * O CONTEXTO DE SESSÃO MORRE NO FIM DA TRANSAÇÃO — E SÓ ASSIM.
 *
 * O defeito que este portão impede
 * --------------------------------
 * `set_config('request.jwt.claims', ..., false)` e `SET` de sessão gravam no
 * estado da CONEXÃO, não da transação. A conexão volta para o pool com os
 * claims da pessoa que acabou de sair, e a próxima requisição — de outra
 * pessoa, de outro locatário — pega essa conexão já carimbada.
 *
 * O vazamento é de IDENTIDADE, não de desempenho: a RLS faz o trabalho dela
 * direitinho, aplicando as policies do tenant errado. Nada falha, nada registra,
 * e o sintoma é alguém vendo dado de outra empresa de vez em quando — na
 * frequência em que o pool reaproveita a conexão, que é a pior frequência
 * possível para reproduzir.
 *
 * Por que é portão e não convenção
 * -------------------------------
 * O terceiro argumento de `set_config` é um booleano no fim de uma linha
 * comprida. Trocá-lo por `false` não quebra nada: todo teste continua passando,
 * porque cada teste usa uma conexão por vez. Só produção, com pool e
 * concorrência, mostra. É o tipo de erro que precisa ser impedido na escrita.
 *
 * O que ele NÃO cobre, dito em voz alta
 * -------------------------------------
 * SQL montado em tempo de execução a partir de pedaços escapa desta peneira.
 * Por isso esta camada escreve o comando inteiro num literal só — e é a razão
 * de `aplicarSessao` ser o único lugar do projeto que fala com `set`.
 */

const RAIZ = 'src'

function arquivos(dir: string, achados: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) arquivos(p, achados)
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) achados.push(p)
  }
  return achados
}

/*
 * O comentário sai, mas as QUEBRAS DE LINHA dele ficam.
 *
 * A primeira versão trocava o comentário inteiro por um espaço. O conteúdo
 * conferido ficava certo e o número da linha, errado: um comentário de dez
 * linhas empurrava todo o resto do arquivo dez linhas para cima, e o relatório
 * mandava quem fosse consertar para o lugar errado. Foi assim que a prova de
 * falsificação apontou a linha 76 de um defeito que estava na 131.
 */
const semComentarios = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, (bloco) => bloco.replace(/[^\n]/g, ' '))
const FONTE = new Map(arquivos(RAIZ).map((f) => [f, semComentarios(readFileSync(f, 'utf8'))]))

/** Toda chamada a `set_config(...)` escrita no código, com o arquivo e a linha. */
function chamadasDeSetConfig(): { arquivo: string; linha: number; texto: string }[] {
  const out: { arquivo: string; linha: number; texto: string }[] = []
  for (const [arquivo, texto] of FONTE) {
    texto.split('\n').forEach((l, i) => {
      if (l.includes('set_config(')) out.push({ arquivo, linha: i + 1, texto: l.trim() })
    })
  }
  return out
}

describe('contexto de sessão no banco', () => {
  it('toda chamada a set_config é local à transação', () => {
    /* O terceiro argumento é `is_local`. `true` = morre no COMMIT/ROLLBACK. */
    const naoLocais = chamadasDeSetConfig().filter(
      (c) => !/set_config\([^)]*,\s*true\s*\)/.test(c.texto),
    )

    expect(
      naoLocais.map((c) => `${c.arquivo}:${c.linha} — ${c.texto}`),
      'set_config sem `true` grava na CONEXÃO: ela volta para o pool carimbada ' +
        'e a próxima requisição, de outra pessoa, herda estes claims',
    ).toEqual([])
  })

  it('ninguém usa SET de sessão para papel ou claims', () => {
    const achados: string[] = []
    for (const [arquivo, texto] of FONTE) {
      texto.split('\n').forEach((l, i) => {
        /* `set local role` é o certo; `set role` sem `local` vaza igual. */
        if (/\bset\s+role\b/i.test(l) && !/\bset\s+local\s+role\b/i.test(l)) {
          achados.push(`${arquivo}:${i + 1} — ${l.trim()}`)
        }
      })
    }
    expect(achados, '`set role` sem `local` sobrevive ao fim da transação').toEqual([])
  })

  it('o papel vem de lista fechada, nunca interpolado como veio', () => {
    /*
     * `set local role` não aceita parâmetro — o nome faz parte da sintaxe, e é
     * o único ponto desta camada em que algo entra no SQL sem ser parâmetro.
     * Então o que protege é a lista fechada logo acima da interpolação.
     */
    const conexao = FONTE.get('src/lib/db/conexao.ts')
    expect(conexao, 'src/lib/db/conexao.ts sumiu — o caminho mudou?').toBeDefined()

    const trecho = conexao!.slice(
      conexao!.indexOf('async function aplicarSessao'),
      conexao!.indexOf('set local role ${papel}') + 40,
    )
    expect(trecho).toContain("'authenticated'")
    expect(trecho).toContain("'service_role'")
    expect(trecho).toContain("'anon'")
  })

  it('a peneira enxerga o que deveria ler', () => {
    /*
     * Guarda contra vacuidade. Sem ela, renomear `src/lib/db` faz as três
     * asserções acima passarem por não encontrarem nada — e um portão que não
     * acha arquivo nenhum é indistinguível de um portão aprovando.
     */
    expect(FONTE.size, 'nenhum arquivo lido — o caminho mudou?').toBeGreaterThan(100)
    expect(
      chamadasDeSetConfig().length,
      'nenhum set_config encontrado: ou a camada mudou de forma, ou a peneira quebrou',
    ).toBeGreaterThan(0)
  })
})
