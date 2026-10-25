import Link from 'next/link'
import type { Route } from 'next'
import { trechosDaLinha } from '@/lib/agent/metricas'
import { emReais } from '@/lib/orcamento/rateio'
import { paraExibicao } from '@/lib/projetos/competencia'
import { barrasDaSerie, lerASerie, pontosDaLinha, tetoDaEscala } from '@/lib/gestao/serie'
import { META_PADRAO_DE_SLA } from '@/lib/gestao/conferencia'

export interface PontoDaSerie {
  competencia: string
  gasto: number
  conformidade: number | null
  com_acordo: number
  projetos_atrasados: number
}

/**
 * Custo, conformidade e atraso no mesmo eixo de tempo.
 *
 * ## Por que dois quadros, e não duas linhas num quadro só
 *
 * Reais e porcento não compartilham escala. Sobrepor os dois num quadro exige
 * dois eixos verticais, e **dois eixos fabricam a correlação**: basta esticar
 * um deles para a linha do custo cruzar a da conformidade onde se quiser. Quem
 * olha lê "o custo subiu e a conformidade caiu junto" — uma conclusão que o
 * desenhista escolheu, não que o dado sustenta.
 *
 * Dois quadros empilhados sobre o mesmo eixo de meses mostram a mesma
 * coincidência sem afirmá-la. A pessoa compara as colunas; o gráfico não
 * conclui por ela.
 *
 * ## Por que SVG na mão, de novo
 *
 * Mesmo motivo de `grafico-horas.tsx`: uma biblioteca de gráficos pesa entre 90
 * e 250 KB comprimidos, e há um teste que falha se a rota passar de 700 KB.
 * Isto é um componente de servidor que não manda JavaScript nenhum.
 *
 * O `<title>` dentro de cada barra entrega o contexto do ponto ao ponteiro —
 * que é metade do contrato de leitura do painel do GSTI — sem uma linha de JS.
 */
export function SerieDoResultado({
  pontos,
  competenciaAtiva,
  href,
  meta = META_PADRAO_DE_SLA,
}: {
  pontos: PontoDaSerie[]
  competenciaAtiva: string
  href: (p: Record<string, string>) => Route
  meta?: number
}) {
  if (pontos.length < 2) {
    return (
      <p className="text-sm text-[var(--color-ink-3)]">
        A série precisa de pelo menos dois meses para dizer alguma coisa. Com um mês só, o que há é
        o número do cartão acima.
      </p>
    )
  }

  const L = 720
  const ALTURA_BARRAS = 90
  const ALTURA_LINHA = 60

  const rotulos = pontos.map((p) => paraExibicao(p.competencia))
  const gastos = pontos.map((p) => Number(p.gasto))
  const conformidades = pontos.map((p) => (p.conformidade === null ? null : Number(p.conformidade)))

  const teto = tetoDaEscala(gastos)
  const barras = barrasDaSerie(gastos, L, ALTURA_BARRAS, teto)
  const trechos = trechosDaLinha(conformidades, L, ALTURA_LINHA)
  const marcas = pontosDaLinha(conformidades, L, ALTURA_LINHA)
  const yDaMeta = ALTURA_LINHA - (meta / 100) * ALTURA_LINHA

  const indiceAtivo = pontos.findIndex((p) => p.competencia === competenciaAtiva)

  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-[var(--color-ink)]">
          {pontos.length} meses até {rotulos[rotulos.length - 1]}
        </span>
        <span className="text-xs text-[var(--color-ink-3)]">
          teto da escala: {emReais(teto)} · meta de SLA: {meta}%
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${L} ${ALTURA_BARRAS + ALTURA_LINHA + 16}`}
        className="h-48 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={lerASerie(rotulos, gastos, conformidades)}
      >
        {/* ---- Quadro de cima: o gasto ---- */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={L}
            y1={ALTURA_BARRAS * (1 - f)}
            y2={ALTURA_BARRAS * (1 - f)}
            stroke="var(--color-border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {barras.map((b, i) => (
          <rect
            key={`barra-${pontos[i]!.competencia}`}
            x={b.x}
            y={b.y}
            width={b.largura}
            height={b.altura}
            rx="1"
            fill={i === indiceAtivo ? 'var(--color-brand)' : 'var(--color-brand-soft)'}
            stroke={i === indiceAtivo ? 'none' : 'var(--color-brand)'}
            strokeWidth={i === indiceAtivo ? 0 : 1}
            vectorEffect="non-scaling-stroke"
          >
            {/* O contexto do ponto, no ponteiro, sem JavaScript nenhum. */}
            <title>
              {rotulos[i]}: {emReais(gastos[i]!)}
              {pontos[i]!.projetos_atrasados > 0
                ? ` · ${pontos[i]!.projetos_atrasados} projeto(s) em atraso`
                : ''}
            </title>
          </rect>
        ))}

        {/* ---- Quadro de baixo: a conformidade ---- */}
        <g transform={`translate(0 ${ALTURA_BARRAS + 16})`}>
          <line
            x1="0"
            x2={L}
            y1={ALTURA_LINHA}
            y2={ALTURA_LINHA}
            stroke="var(--color-border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1="0"
            x2={L}
            y1={yDaMeta}
            y2={yDaMeta}
            stroke="var(--color-ok-ink)"
            strokeWidth="1"
            strokeDasharray="4 4"
            opacity="0.6"
            vectorEffect="non-scaling-stroke"
          />
          {trechos.map((d, i) => (
            <path
              key={`conf-${i}`}
              d={d}
              fill="none"
              stroke="var(--color-ink-2)"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {marcas.map((m) => (
            <circle
              key={`marca-${pontos[m.indice]!.competencia}`}
              cx={m.x}
              cy={m.y}
              r="3"
              fill={m.valor >= meta ? 'var(--color-ok-ink)' : 'var(--color-breach-ink)'}
            >
              <title>
                {rotulos[m.indice]}: {m.valor.toFixed(1).replace('.', ',')}% de conformidade em{' '}
                {pontos[m.indice]!.com_acordo} chamado(s) com acordo
              </title>
            </circle>
          ))}
        </g>
      </svg>

      {/* Os meses, como destinos. Clicar no mês troca o recorte da tela inteira
          — é o mesmo gesto de abrir o número, só que para trás no tempo. */}
      <div className="mt-2 flex gap-px">
        {pontos.map((p, i) => (
          <Link
            key={p.competencia}
            href={href({ competencia: p.competencia })}
            aria-current={i === indiceAtivo ? 'page' : undefined}
            className={`flex flex-1 flex-col items-center rounded py-1 text-center text-[10px] leading-tight hover:bg-[var(--color-surface-2)] ${
              i === indiceAtivo
                ? 'font-semibold text-[var(--color-brand-ink)]'
                : 'text-[var(--color-ink-3)]'
            }`}
          >
            <span className="tabular-nums">{rotulos[i]!.slice(0, 2)}</span>
            {p.projetos_atrasados > 0 && (
              <span
                className="mt-0.5 rounded-full bg-[var(--color-breach-soft)] px-1 font-semibold tabular-nums text-[var(--color-breach-ink)]"
                title={`${p.projetos_atrasados} projeto(s) em atraso em ${rotulos[i]}`}
              >
                {p.projetos_atrasados}
              </span>
            )}
          </Link>
        ))}
      </div>

      <p className="mt-2 text-xs text-[var(--color-ink-3)]">
        Barras: gasto do mês. Linha: conformidade de SLA, com a meta tracejada — mês sem chamado
        coberto é <strong>buraco</strong>, não queda. O número vermelho sob o mês é a quantidade de
        projetos que estavam em atraso naquele mês.{' '}
        <strong>A coincidência entre as três não é causa</strong>; os quadros são separados
        justamente para não afirmar que é.
      </p>
    </figure>
  )
}
