import { describe, expect, it } from 'vitest'
import {
  alteracoesLegiveis,
  nomeDaEntidade,
  ROTULO_DA_ACAO,
  tamanhoDoRegistro,
} from './auditoria'

/**
 * A trilha existe desde a migração 0010 e nunca foi lida por ninguém. O que
 * estes testes protegem é a tradução que a torna legível — e, principalmente, o
 * que ela NÃO deve mostrar.
 */

describe('alteracoesLegiveis', () => {
  it('traduz um update em campo, de e para', () => {
    expect(
      alteracoesLegiveis({ status: { old: 'open', new: 'in_progress' } }),
    ).toEqual([{ campo: 'status', de: 'open', para: 'in_progress' }])
  })

  it('criação e exclusão NÃO viram lista de campos', () => {
    /*
     * O diff de um insert é a linha inteira. Listar as 30 colunas de um chamado
     * recém-criado afogaria a trilha — e a informação útil ("fulano criou") já
     * está na própria ação.
     */
    expect(alteracoesLegiveis({ created: { id: 'x', title: 'y', status: 'open' } })).toEqual([])
    expect(alteracoesLegiveis({ deleted: { id: 'x' } })).toEqual([])
  })

  it('descarta o ruído que está em toda linha', () => {
    const r = alteracoesLegiveis({
      tenant_id: { old: 'a', new: 'b' },
      updated_at: { old: '1', new: '2' },
      name: { old: 'Antes', new: 'Depois' },
    })
    expect(r).toEqual([{ campo: 'name', de: 'Antes', para: 'Depois' }])
  })

  it('booleano vira sim/não e nulo vira travessão', () => {
    // "false → true" não diz nada a quem lê; "não → sim" diz.
    expect(alteracoesLegiveis({ is_active: { old: false, new: true } })[0]).toEqual({
      campo: 'is_active',
      de: 'não',
      para: 'sim',
    })
    expect(alteracoesLegiveis({ nota: { old: null, new: 'oi' } })[0]!.de).toBe('—')
  })

  it('string vazia é distinguida de nulo', () => {
    // Os dois apareceriam iguais se ambos virassem travessão, e a diferença
    // importa: "apagou o texto" não é "nunca teve texto".
    expect(alteracoesLegiveis({ nota: { old: '', new: 'x' } })[0]!.de).toBe('(vazio)')
  })

  it('corta texto longo em vez de despejar a descrição inteira', () => {
    const longo = 'a'.repeat(500)
    const r = alteracoesLegiveis({ description: { old: '', new: longo } })
    expect(r[0]!.para.length).toBeLessThanOrEqual(121)
    expect(r[0]!.para.endsWith('…')).toBe(true)
  })

  it('não quebra com payload fora de forma', () => {
    for (const lixo of [null, undefined, {}, { x: 'nao-e-objeto' }, { x: {} }]) {
      expect(alteracoesLegiveis(lixo as Record<string, unknown>)).toEqual([])
    }
  })
})

describe('nomeDaEntidade', () => {
  it('traduz o que conhece', () => {
    expect(nomeDaEntidade('it_assets')).toBe('Ativo de TI')
  })

  it('e devolve o nome cru do que não conhece', () => {
    /*
     * Deliberado: uma migração nova acrescenta uma tabela auditada antes de
     * alguém lembrar de traduzi-la. Nome técnico é feio e é honesto; a tela não
     * pode quebrar nem esconder a linha por causa disso.
     */
    expect(nomeDaEntidade('tabela_do_futuro')).toBe('tabela_do_futuro')
  })
})

describe('tamanhoDoRegistro', () => {
  it('conta as colunas de uma criação', () => {
    expect(tamanhoDoRegistro({ created: { a: 1, b: 2 } })).toBe(2)
  })

  it('devolve null para um update', () => {
    expect(tamanhoDoRegistro({ status: { old: 'a', new: 'b' } })).toBeNull()
  })
})

describe('ROTULO_DA_ACAO', () => {
  it('cobre as três ações que a trigger grava', () => {
    expect(Object.keys(ROTULO_DA_ACAO).sort()).toEqual(['delete', 'insert', 'update'])
  })
})
