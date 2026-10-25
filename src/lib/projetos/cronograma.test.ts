import { describe, expect, it } from 'vitest'
import {
  anoDe,
  competenciaAtual,
  faixaDeMeses,
  MAXIMO_DE_MESES,
  mesCurto,
  mesesEntre,
  paraExibicao,
  paraInterno,
  somarMeses,
} from './competencia'
import {
  barrasDaLinha,
  emOrdemDeLeitura,
  faixaDoCronograma,
  intervaloDoGrupo,
  type TarefaDoCronograma,
} from './cronograma'

/**
 * O que estes testes protegem
 * --------------------------
 * Um Gantt errado não dá erro: ele desenha a barra no lugar errado, e quem olha
 * acredita. As três coisas que erram em silêncio são a ordem de leitura da
 * hierarquia, o intervalo agregado de um grupo comprimido e a posição da barra
 * na faixa de meses. As três estão aqui.
 */

const t = (p: Partial<TarefaDoCronograma> & { id: string }): TarefaDoCronograma => ({
  parent_task_id: null,
  name: p.id,
  start_month: '2026-01-01',
  planned_end_month: '2026-03-01',
  actual_end_month: null,
  assignee: null,
  status: 'pendente',
  meses_atraso: 0,
  desvio_meses: 0,
  atrasado: false,
  ...p,
})

describe('competência', () => {
  it('aceita os três formatos que chegam de verdade', () => {
    /*
     * `<input type="month">` manda AAAA-MM; a planilha manda MM/AAAA; o banco
     * devolve AAAA-MM-DD. Os três passam pela mesma porta.
     */
    expect(paraInterno('2026-04')).toBe('2026-04-01')
    expect(paraInterno('04/2026')).toBe('2026-04-01')
    expect(paraInterno('4/2026')).toBe('2026-04-01')
    expect(paraInterno('2026-04-01')).toBe('2026-04-01')
  })

  it('recusa mês inválido em vez de gravar o que o banco leria de outro jeito', () => {
    for (const lixo of ['2026-13', '13/2026', '00/2026', 'abril', '', null, undefined, '2026']) {
      expect(paraInterno(lixo)).toBeNull()
    }
  })

  it('exibe no formato brasileiro', () => {
    expect(paraExibicao('2026-04-01')).toBe('04/2026')
    expect(paraExibicao(null)).toBe('')
  })

  it('a competência atual é sempre o dia 1', () => {
    expect(competenciaAtual(new Date('2026-07-23T15:00:00Z'))).toBe('2026-07-01')
  })

  it('soma meses atravessando o ano', () => {
    expect(somarMeses('2026-11-01', 3)).toBe('2027-02-01')
    expect(somarMeses('2026-02-01', -3)).toBe('2025-11-01')
  })

  it('a diferença tem sinal', () => {
    expect(mesesEntre('2026-01-01', '2026-04-01')).toBe(3)
    expect(mesesEntre('2026-04-01', '2026-01-01')).toBe(-3)
    expect(mesesEntre('2026-01-01', '2027-01-01')).toBe(12)
  })

  it('a faixa inclui as duas pontas', () => {
    expect(faixaDeMeses('2026-01-01', '2026-03-01')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ])
  })

  it('a faixa tem teto, porque ano digitado errado travaria a tela', () => {
    /*
     * "2206" em vez de "2026" é um erro de digitação que gera 2.160 colunas. Sem
     * teto, o cronograma para de responder — e o sintoma não aponta para a causa.
     */
    expect(faixaDeMeses('2026-01-01', '2206-01-01').length).toBe(MAXIMO_DE_MESES)
  })

  it('rótulo curto do mês e ano', () => {
    expect(mesCurto('2026-04-01')).toBe('abr')
    expect(anoDe('2026-04-01')).toBe('2026')
  })
})

describe('ordem de leitura', () => {
  it('cada principal vem seguida das suas subtarefas', () => {
    const linhas = emOrdemDeLeitura([
      t({ id: 'b' }),
      t({ id: 'a' }),
      t({ id: 'a1', parent_task_id: 'a' }),
      t({ id: 'a2', parent_task_id: 'a' }),
      t({ id: 'a1x', parent_task_id: 'a1' }),
    ])
    expect(linhas.map((l) => l.id)).toEqual(['a', 'a1', 'a1x', 'a2', 'b'])
    expect(linhas.map((l) => l.nivel)).toEqual([1, 2, 3, 2, 1])
  })

  it('conta a subárvore inteira, não só as filhas diretas', () => {
    const linhas = emOrdemDeLeitura([
      t({ id: 'a' }),
      t({ id: 'a1', parent_task_id: 'a' }),
      t({ id: 'a1x', parent_task_id: 'a1' }),
    ])
    expect(linhas[0]!.total_subtarefas).toBe(1)
    expect(linhas[0]!.total_na_subarvore).toBe(2)
  })

  it('tarefa cujo pai foi excluído volta ao primeiro nível, em vez de sumir', () => {
    /*
     * Exclusão lógica do pai deixa a filha órfã, e uma árvore montada por
     * `parent_task_id` não a encontraria: a tarefa desapareceria da tela sem ter
     * sido excluída. Órfã visível é corrigível; órfã invisível, não.
     */
    const linhas = emOrdemDeLeitura([t({ id: 'orfa', parent_task_id: 'pai-que-sumiu' })])
    expect(linhas).toHaveLength(1)
    expect(linhas[0]!.nivel).toBe(1)
  })

  it('ciclo já gravado não trava a renderização', () => {
    // A trigger da 0037 impede que um entre, mas base restaurada de versão
    // antiga pode ter um — e laço infinito aqui é a tela que não carrega, sem
    // erro nenhum para apontar a causa.
    const linhas = emOrdemDeLeitura([
      t({ id: 'x', parent_task_id: 'y' }),
      t({ id: 'y', parent_task_id: 'x' }),
    ])
    expect(linhas.length).toBeLessThanOrEqual(2)
  })

  it('empate de mês é desfeito pelo nome, para a ordem ser estável', () => {
    const linhas = emOrdemDeLeitura([
      t({ id: '2', name: 'Zebra', start_month: '2026-01-01' }),
      t({ id: '1', name: 'Abacaxi', start_month: '2026-01-01' }),
    ])
    expect(linhas.map((l) => l.name)).toEqual(['Abacaxi', 'Zebra'])
  })
})

describe('barras', () => {
  const meses = faixaDeMeses('2026-01-01', '2026-06-01')

  it('um mês é uma coluna', () => {
    const b = barrasDaLinha(
      { start_month: '2026-02-01', planned_end_month: '2026-02-01', actual_end_month: null },
      meses,
    )
    expect(b.planejada).toEqual({ inicio: 1, duracao: 1 })
  })

  it('a barra planejada cobre do início ao fim planejado', () => {
    const b = barrasDaLinha(
      { start_month: '2026-02-01', planned_end_month: '2026-04-01', actual_end_month: null },
      meses,
    )
    expect(b.planejada).toEqual({ inicio: 1, duracao: 3 })
  })

  it('sem fim real NÃO existe barra realizada', () => {
    /*
     * Desenhar a realizada até o mês corrente faria uma tarefa esquecida parecer
     * em andamento — que é o oposto do que o cronograma deve mostrar.
     */
    const b = barrasDaLinha(
      { start_month: '2026-02-01', planned_end_month: '2026-04-01', actual_end_month: null },
      meses,
    )
    expect(b.realizada).toBeNull()
  })

  it('com fim real, a realizada aparece e pode ser mais curta', () => {
    const b = barrasDaLinha(
      { start_month: '2026-02-01', planned_end_month: '2026-04-01', actual_end_month: '2026-03-01' },
      meses,
    )
    expect(b.realizada).toEqual({ inicio: 1, duracao: 2 })
  })

  it('data fora da faixa é grampeada, não vira coluna negativa', () => {
    const b = barrasDaLinha(
      { start_month: '2025-01-01', planned_end_month: '2030-01-01', actual_end_month: null },
      meses,
    )
    expect(b.planejada.inicio).toBe(0)
    expect(b.planejada.inicio + b.planejada.duracao).toBeLessThanOrEqual(meses.length)
  })
})

describe('grupo comprimido', () => {
  it('a barra cobre o intervalo AGREGADO da subárvore', () => {
    /*
     * A regra que mais importa do Gantt agrupável: esconder as subtarefas não
     * pode encolher o tempo que elas ocupam. Um pai de março a abril com uma
     * filha até setembro mostra março–setembro quando comprimido.
     */
    const linhas = emOrdemDeLeitura([
      t({ id: 'pai', start_month: '2026-03-01', planned_end_month: '2026-04-01' }),
      t({
        id: 'filha',
        parent_task_id: 'pai',
        start_month: '2026-03-01',
        planned_end_month: '2026-09-01',
      }),
    ])
    const g = intervaloDoGrupo(linhas, 0)
    expect(g.start_month).toBe('2026-03-01')
    expect(g.planned_end_month).toBe('2026-09-01')
  })

  it('o realizado do grupo só aparece com a subárvore INTEIRA entregue', () => {
    // Uma barra realizada parcial diria que o grupo foi entregue.
    const parcial = emOrdemDeLeitura([
      t({ id: 'pai', actual_end_month: '2026-03-01' }),
      t({ id: 'filha', parent_task_id: 'pai', actual_end_month: null }),
    ])
    expect(intervaloDoGrupo(parcial, 0).actual_end_month).toBeNull()

    const inteira = emOrdemDeLeitura([
      t({ id: 'pai', actual_end_month: '2026-03-01' }),
      t({ id: 'filha', parent_task_id: 'pai', actual_end_month: '2026-05-01' }),
    ])
    expect(intervaloDoGrupo(inteira, 0).actual_end_month).toBe('2026-05-01')
  })
})

describe('faixa do cronograma', () => {
  it('envolve o projeto com um mês de margem de cada lado', () => {
    const f = faixaDoCronograma(
      [{ start_month: '2026-03-01', planned_end_month: '2026-05-01', actual_end_month: null }],
      '2026-04-01',
    )
    expect(f[0]).toBe('2026-02-01')
    expect(f[f.length - 1]).toBe('2026-06-01')
  })

  it('o mês corrente entra mesmo estando fora do projeto', () => {
    /*
     * O marcador de "hoje" é o que diz, de olhar, se o projeto está atrasado.
     * Fora da faixa, ele não aparece — e um projeto que terminou de planejar em
     * 2025 pareceria em dia.
     */
    const f = faixaDoCronograma(
      [{ start_month: '2025-01-01', planned_end_month: '2025-03-01', actual_end_month: null }],
      '2026-08-01',
    )
    expect(f).toContain('2026-08-01')
  })

  it('projeto sem tarefa devolve uma faixa em torno de hoje', () => {
    const f = faixaDoCronograma([], '2026-04-01')
    expect(f).toEqual(['2026-03-01', '2026-04-01', '2026-05-01'])
  })
})
