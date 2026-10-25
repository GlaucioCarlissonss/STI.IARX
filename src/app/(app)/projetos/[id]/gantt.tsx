'use client'

import { useState } from 'react'
import {
  anoDe,
  competenciaAtual,
  mesCurto,
  paraExibicao,
} from '@/lib/projetos/competencia'
import {
  barrasDaLinha,
  emOrdemDeLeitura,
  faixaDoCronograma,
  intervaloDoGrupo,
  type TarefaDoCronograma,
} from '@/lib/projetos/cronograma'

/**
 * O cronograma, em meses.
 *
 * ## Por que uma grade de CSS e não uma biblioteca
 *
 * Um Gantt mensal é uma tabela: linhas de tarefa, colunas de mês, barras que
 * ocupam colunas contíguas. `grid-column` faz isso em três linhas de CSS. Uma
 * biblioteca traria arrastar-e-soltar, zoom por dia e dependências entre tarefas
 * — recursos que este cronograma não tem e cuja ausência não se nota, em troca de
 * centenas de kB no pacote e de um componente que não funciona no tema escuro
 * sem remendo.
 *
 * ## O que ele mostra
 *
 * - **Barra planejada** em cima, **realizada** logo abaixo quando existe.
 * - **Marcador do mês corrente**, que é o que diz de olhar se o projeto atrasou.
 * - **Grupos comprimíveis**: comprimir esconde a subárvore inteira e a barra do
 *   grupo passa a cobrir o intervalo agregado — esconder as subtarefas não pode
 *   encolher o tempo que elas ocupam.
 */
export function Gantt({ tarefas }: { tarefas: TarefaDoCronograma[] }) {
  /*
   * O que fica guardado é o conjunto dos COMPRIMIDOS, não o dos expandidos.
   *
   * Assim um grupo criado depois nasce aberto, em vez de herdar o silêncio de
   * uma lista que não o conhecia. É a decisão do GSTI original, e ela só aparece
   * quando alguém cadastra a primeira subtarefa de um grupo novo.
   */
  const [comprimidos, setComprimidos] = useState<Set<string>>(new Set())

  const linhas = emOrdemDeLeitura(tarefas)
  if (linhas.length === 0) {
    return (
      <p className="text-sm text-[var(--color-ink-3)]">
        Sem tarefas, não há cronograma. Cadastre a primeira abaixo.
      </p>
    )
  }

  const hoje = competenciaAtual()
  const meses = faixaDoCronograma(linhas, hoje)
  const colunaDeHoje = meses.indexOf(hoje)

  /* Esconde quem está sob um grupo comprimido. Percorre em ordem de leitura e
     pula a subárvore inteira — não só as filhas diretas. */
  const visiveis: { linha: (typeof linhas)[number]; indice: number }[] = []
  for (let i = 0; i < linhas.length; i += 1) {
    const l = linhas[i]!
    visiveis.push({ linha: l, indice: i })
    if (comprimidos.has(l.id)) i += l.total_na_subarvore
  }

  function alternar(id: string) {
    setComprimidos((antes) => {
      const novo = new Set(antes)
      if (novo.has(id)) novo.delete(id)
      else novo.add(id)
      return novo
    })
  }

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: `${28 + meses.length * 3.5}rem` }}>
        {/* Cabeçalho dos meses */}
        <div
          className="grid border-b border-[var(--color-border)] pb-1"
          style={{ gridTemplateColumns: `18rem repeat(${meses.length}, minmax(3.5rem, 1fr))` }}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">
            Tarefa
          </div>
          {meses.map((m, i) => (
            <div
              key={m}
              className={`text-center text-xs ${
                i === colunaDeHoje
                  ? 'font-bold text-[var(--color-brand-ink)]'
                  : 'text-[var(--color-ink-3)]'
              }`}
            >
              {mesCurto(m)}
              {/* O ano só aparece em janeiro e na primeira coluna: repeti-lo em
                  toda coluna ocuparia a altura do cabeçalho sem informar nada. */}
              {(i === 0 || m.slice(5, 7) === '01') && (
                <span className="block text-[0.625rem]">{anoDe(m)}</span>
              )}
            </div>
          ))}
        </div>

        {visiveis.map(({ linha, indice }) => {
          const comprimido = comprimidos.has(linha.id)
          const intervalo = comprimido ? intervaloDoGrupo(linhas, indice) : linha
          const { planejada, realizada } = barrasDaLinha(intervalo, meses)

          return (
            <div
              key={linha.id}
              className="grid items-center border-b border-[var(--color-border)] py-1.5"
              style={{ gridTemplateColumns: `18rem repeat(${meses.length}, minmax(3.5rem, 1fr))` }}
            >
              <div
                className="flex min-w-0 items-center gap-1.5 pr-3"
                style={{ paddingLeft: `${(linha.nivel - 1) * 1.25}rem` }}
              >
                {linha.total_subtarefas > 0 ? (
                  <button
                    type="button"
                    onClick={() => alternar(linha.id)}
                    aria-expanded={!comprimido}
                    aria-label={
                      comprimido
                        ? `Expandir ${linha.name} e suas ${linha.total_na_subarvore} subtarefas`
                        : `Comprimir ${linha.name} e suas ${linha.total_na_subarvore} subtarefas`
                    }
                    className="shrink-0 rounded border border-[var(--color-border)] px-1 text-xs leading-none text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]"
                  >
                    {comprimido ? '+' : '−'}
                  </button>
                ) : (
                  <span className="w-[1.125rem] shrink-0" aria-hidden="true" />
                )}
                <span
                  className={`truncate text-sm ${
                    linha.atrasado ? 'text-[var(--color-breach-ink)]' : 'text-[var(--color-ink)]'
                  }`}
                  title={linha.name}
                >
                  {linha.name}
                </span>
                {comprimido && linha.total_na_subarvore > 0 && (
                  <span className="shrink-0 text-xs text-[var(--color-ink-3)]">
                    +{linha.total_na_subarvore}
                  </span>
                )}
              </div>

              {/* As barras ocupam uma faixa de colunas. O `title` leva o
                  contexto do ponto, que é o contrato de leitura desta base. */}
              <div
                className="h-2 rounded-full bg-[var(--color-brand)]"
                style={{
                  gridColumnStart: planejada.inicio + 2,
                  gridColumnEnd: planejada.inicio + 2 + planejada.duracao,
                }}
                title={`${linha.name}: planejado de ${paraExibicao(intervalo.start_month)} a ${paraExibicao(intervalo.planned_end_month)}`}
              />
              {realizada && (
                <div
                  className="mt-0.5 h-2 rounded-full bg-[var(--color-ok-solid)]"
                  style={{
                    gridRow: 1,
                    gridColumnStart: realizada.inicio + 2,
                    gridColumnEnd: realizada.inicio + 2 + realizada.duracao,
                    alignSelf: 'end',
                  }}
                  title={`${linha.name}: entregue em ${paraExibicao(intervalo.actual_end_month)}`}
                />
              )}
            </div>
          )
        })}

        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-[var(--color-ink-3)]">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-6 rounded-full bg-[var(--color-brand)]" />
            planejado
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-6 rounded-full bg-[var(--color-ok-solid)]" />
            realizado
          </span>
          {colunaDeHoje >= 0 && (
            <span className="text-[var(--color-brand-ink)]">
              {mesCurto(hoje)}/{anoDe(hoje)} é o mês corrente
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
