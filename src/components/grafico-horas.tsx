import type { PontoDoGrafico } from '@/lib/agent/metricas'
import { trechosDaLinha } from '@/lib/agent/metricas'

/**
 * Um gráfico de linha de 24 horas, em SVG puro.
 *
 * ## Por que não uma biblioteca de gráficos
 *
 * Recharts, Chart.js e companhia pesam entre 90 e 250 KB comprimidos. Esta
 * aplicação inteira baixa 506 KB na rota mais leve, e há um teste que falha se
 * passar de 700 — acrescentar um quarto disso para desenhar duas linhas de 24
 * pontos seria a decisão errada por uma margem larga.
 *
 * O que uma biblioteca daria e isto não dá: interação rica (zoom, arrasto,
 * tooltip que segue o cursor) e tipos de gráfico que esta tela não usa. O que se
 * ganha: nada para auditar, nada para atualizar, e um componente de servidor que
 * não manda JavaScript nenhum para o navegador.
 *
 * ## As duas linhas, e por que são duas
 *
 * Média e máximo. A média sozinha esconde o pico, e o pico é o que faz a máquina
 * travar: 40% de média com picos de 100% é uma máquina travando, e a média
 * sozinha diria que ela está folgada. O máximo fica mais claro e mais fino —
 * presente sem competir com a leitura principal.
 *
 * ## O buraco é um buraco
 *
 * Hora sem amostra não é ligada por uma reta ao ponto seguinte. Reta num gráfico
 * de CPU é lida como "ficou constante", que é o contrário de "a máquina estava
 * desligada" — e máquina desligada à noite é o caso comum, não a exceção.
 */
export function GraficoHoras({
  pontos,
  metrica,
  titulo,
  unidade = '%',
}: {
  pontos: PontoDoGrafico[]
  metrica: 'cpu' | 'mem'
  titulo: string
  unidade?: string
}) {
  const L = 720
  const A = 120

  const medias = pontos.map((p) => (metrica === 'cpu' ? p.cpu_avg : p.mem_avg_pct))
  const maximos = pontos.map((p) => (metrica === 'cpu' ? p.cpu_max : p.mem_max_pct))

  const comDado = medias.filter((v): v is number => v !== null)
  const pico = maximos.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0)
  const media =
    comDado.length > 0 ? Math.round(comDado.reduce((s, v) => s + v, 0) / comDado.length) : null

  const trechosMedia = trechosDaLinha(medias, L, A)
  const trechosMaximo = trechosDaLinha(maximos, L, A)

  const descricao =
    media === null
      ? `${titulo}: sem amostras nas últimas ${pontos.length} horas.`
      : `${titulo}: média de ${media}${unidade} e pico de ${pico}${unidade} nas últimas ${pontos.length} horas, em ${comDado.length} horas com amostra.`

  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-[var(--color-ink)]">{titulo}</span>
        <span className="text-xs text-[var(--color-ink-3)]">
          {media === null ? (
            'sem amostras'
          ) : (
            <>
              média {media}
              {unidade} · pico {pico}
              {unidade}
            </>
          )}
        </span>
      </figcaption>

      {comDado.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-line)] px-3 py-6 text-center text-sm text-[var(--color-ink-3)]">
          Nenhuma amostra nas últimas {pontos.length} horas. A máquina pode estar desligada, ou o
          agente pode ter parado.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${L} ${A}`}
          className="h-28 w-full"
          preserveAspectRatio="none"
          role="img"
          /* O gráfico é informação, não enfeite: quem usa leitor de tela recebe a
             mesma conclusão que quem olha — média, pico e quantas horas tinham
             dado. É a diferença entre um gráfico acessível e um gráfico com
             `alt=""`. */
          aria-label={descricao}
        >
          {/* As três linhas de referência. 90% é onde o alerta mora, e por isso
              ela é a única destacada. */}
          {[25, 50, 75].map((v) => (
            <line
              key={v}
              x1="0"
              x2={L}
              y1={A - (v / 100) * A}
              y2={A - (v / 100) * A}
              stroke="var(--color-line)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1="0"
            x2={L}
            y1={A - 0.9 * A}
            y2={A - 0.9 * A}
            stroke="var(--color-warn-ink)"
            strokeWidth="1"
            strokeDasharray="4 4"
            opacity="0.5"
            vectorEffect="non-scaling-stroke"
          />

          {trechosMaximo.map((d, i) => (
            <path
              key={`max-${i}`}
              d={d}
              fill="none"
              stroke="var(--color-ink-3)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {trechosMedia.map((d, i) => (
            <path
              key={`med-${i}`}
              d={d}
              fill="none"
              stroke="var(--color-brand)"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}

      <div className="mt-1 flex justify-between text-xs text-[var(--color-ink-3)]">
        <span>{pontos.length}h atrás</span>
        <span>
          <span className="inline-block h-0.5 w-3 align-middle" style={{ background: 'var(--color-brand)' }} />{' '}
          média
          {'  '}
          <span className="inline-block h-px w-3 align-middle" style={{ background: 'var(--color-ink-3)' }} />{' '}
          pico
        </span>
        <span>agora</span>
      </div>
    </figure>
  )
}
