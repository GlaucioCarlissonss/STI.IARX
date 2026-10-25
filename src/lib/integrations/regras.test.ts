import { describe, expect, it } from 'vitest'
import {
  CAMPOS_DE_TICKET,
  DESCRICAO_DA_TRANSFORMACAO,
  ROTULO_DO_CAMPO,
  TRANSFORMACOES,
  escreverMapaDeValores,
  lerMapaDeValores,
} from './regras'
import { applyMapping } from './mapping'

/**
 * O que estes testes protegem
 * ---------------------------
 * O de-para é a parte do mapeamento que mais muda, e é editada por quem está
 * lendo uma lista de status num sistema de terceiros. Os erros dele são todos
 * silenciosos: uma chave repetida faz a última ganhar, uma linha pela metade
 * vira um par vazio, e o resultado não é um erro — é um chamado com o campo em
 * branco, semanas depois.
 */

describe('lerMapaDeValores', () => {
  it('lê um par por linha', () => {
    const r = lerMapaDeValores('em andamento = in_progress\nconcluído = resolved')
    expect('erro' in r).toBe(false)
    expect((r as { valores: Record<string, string> }).valores).toEqual({
      'em andamento': 'in_progress',
      concluído: 'resolved',
    })
  })

  it('ignora linhas em branco e espaços', () => {
    const r = lerMapaDeValores('\n  novo   =   open  \n\n')
    expect((r as { valores: Record<string, string> }).valores).toEqual({ novo: 'open' })
  })

  it('aceita "=" no valor de destino', () => {
    // O corte é no PRIMEIRO "=", senão um valor com sinal de igual quebraria.
    const r = lerMapaDeValores('chave = a=b')
    expect((r as { valores: Record<string, string> }).valores).toEqual({ chave: 'a=b' })
  })

  it('recusa linha sem "=", dizendo QUAL linha', () => {
    const r = lerMapaDeValores('novo = open\nconcluído')
    expect('erro' in r).toBe(true)
    expect((r as { erro: string }).erro).toContain('Linha 2')
  })

  it('recusa linha pela metade', () => {
    expect('erro' in lerMapaDeValores('= open')).toBe(true)
    expect('erro' in lerMapaDeValores('novo =')).toBe(true)
  })

  it('recusa chave repetida em vez de deixar a última ganhar', () => {
    /*
     * Em objeto, a segunda sobrescreve a primeira sem ruído — e a pessoa fica
     * com duas linhas na tela, uma das quais não faz nada. Qual delas, não dá
     * para saber olhando.
     */
    const r = lerMapaDeValores('novo = open\nnovo = pending')
    expect('erro' in r).toBe(true)
    expect((r as { erro: string }).erro).toContain('duas vezes')
  })

  it('ida e volta preserva o conteúdo', () => {
    const texto = 'em andamento = in_progress\nconcluído = resolved'
    const lido = lerMapaDeValores(texto) as { valores: Record<string, string> }
    expect(escreverMapaDeValores(lido.valores)).toBe(texto)
  })
})

describe('o vocabulário da tela', () => {
  it('todo campo tem rótulo em português', () => {
    // Sem isto, um campo novo aparece na lista com o nome da coluna do banco —
    // e quem edita o mapeamento passa a escolher entre `priority_key` e
    // `requester_id` sem saber o que são.
    for (const campo of CAMPOS_DE_TICKET) {
      expect(ROTULO_DO_CAMPO[campo]).toBeTruthy()
    }
  })

  it('toda transformação tem explicação', () => {
    for (const t of TRANSFORMACOES) {
      expect(DESCRICAO_DA_TRANSFORMACAO[t]).toBeTruthy()
    }
  })

  it('a lista de transformações é a MESMA que o motor conhece', () => {
    /*
     * Esta é a asserção que importa: a tela oferece uma transformação, o motor
     * executa outra lista. Se divergirem, a pessoa escolhe uma opção que nunca
     * é aplicada — o `switch` cai fora, nenhum erro é levantado, e o campo
     * simplesmente não é preenchido.
     */
    const doMotor = new Set<string>()
    for (const t of TRANSFORMACOES) {
      const r = applyMapping(
        { x: '1' },
        [{ source_path: 'x', target_field: 'title', transform: t, default_value: 'c' }],
      )
      // Toda transformação tem de produzir ALGO: campo, busca pendente ou erro.
      const produziu =
        Object.keys(r.fields).length > 0 || r.lookups.length > 0 || r.errors.length > 0
      if (produziu) doMotor.add(t)
    }
    expect(doMotor.size).toBe(TRANSFORMACOES.length)
  })
})
