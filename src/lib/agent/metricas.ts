import { z } from 'zod'

/**
 * O contrato das amostras de desempenho.
 *
 * Separado de `inventario.ts` porque as duas coisas têm vida diferente e isso
 * não é organização de arquivo, é consequência do modelo: inventário é
 * configuração (muda poucas vezes por ano, vira histórico por mudança), métrica
 * é série temporal (muda sempre, vira agregado e expira).
 *
 * Os nomes são curtos — `em`, `cpu`, `mem_usada` — e isso é deliberado: numa
 * frota de 200 máquinas enviando 288 amostras por dia, o nome dos campos é uma
 * fração real do tráfego. Num payload de inventário, que sai uma vez por ano por
 * máquina, a legibilidade ganharia.
 */

export const volumeSchema = z.object({
  ponto: z.string().trim().min(1).max(120),
  total: z.number().int().positive(),
  livre: z.number().int().nonnegative(),
})

export const amostraSchema = z.object({
  /** Quando foi coletada, no relógio da máquina. O servidor recusa o absurdo. */
  em: z.string().datetime(),
  cpu: z.number().min(0).max(100).optional(),
  mem_usada: z.number().int().nonnegative().optional(),
  mem_total: z.number().int().nonnegative().optional(),
  ligada_s: z.number().int().nonnegative().optional(),
  volumes: z.array(volumeSchema).max(64).optional(),
  /*
   * Os serviços críticos que estavam FORA neste instante — a exceção, não o
   * estado completo. Mandar "estes 40 serviços estão no ar" a cada cinco minutos
   * seria transmitir e gravar a mesma lista 100 mil vezes por dia para descobrir
   * o dia em que um sumiu.
   */
  servicos_fora: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
})

export const loteDeMetricasSchema = z.object({
  /*
   * Teto de 500 amostras. Com uma amostra a cada 5 minutos, 500 são quase dois
   * dias — folga suficiente para um notebook que passou o fim de semana fora da
   * rede, e um teto que impede a fila represada de um mês virar uma requisição
   * que o servidor corta no meio.
   */
  amostras: z.array(amostraSchema).min(1).max(500),
})

export type Amostra = z.infer<typeof amostraSchema>

export interface PontoDoGrafico {
  hora: string
  cpu_avg: number | null
  cpu_max: number | null
  mem_avg_pct: number | null
  mem_max_pct: number | null
}

/**
 * Preenche as horas que não têm amostra.
 *
 * Sem isto, um gráfico de 24 horas de uma máquina que ficou desligada das 18h às
 * 8h desenharia uma linha reta ligando os dois pontos — e linha reta num gráfico
 * de CPU é lida como "a máquina ficou constante", que é o contrário de
 * "a máquina estava desligada". O buraco precisa parecer um buraco.
 */
export function completarHoras(
  pontos: PontoDoGrafico[],
  horas: number,
  agora = new Date(),
): PontoDoGrafico[] {
  const porHora = new Map<string, PontoDoGrafico>()
  for (const p of pontos) {
    porHora.set(new Date(p.hora).toISOString().slice(0, 13), p)
  }

  const fim = new Date(agora)
  fim.setUTCMinutes(0, 0, 0)

  const saida: PontoDoGrafico[] = []
  for (let i = horas - 1; i >= 0; i -= 1) {
    const h = new Date(fim.getTime() - i * 3_600_000)
    const chave = h.toISOString().slice(0, 13)
    saida.push(
      porHora.get(chave) ?? {
        hora: h.toISOString(),
        cpu_avg: null,
        cpu_max: null,
        mem_avg_pct: null,
        mem_max_pct: null,
      },
    )
  }
  return saida
}

/**
 * Os comandos de uma linha de gráfico, com buraco onde não há dado.
 *
 * Devolve uma lista de trechos em vez de um `path` só: `M` no meio de um `d`
 * funciona, mas produz um caminho que não dá para estilizar por trecho nem
 * inspecionar. Trechos separados também deixam o buraco explícito no DOM.
 */
export function trechosDaLinha(
  valores: (number | null)[],
  largura: number,
  altura: number,
  maximo = 100,
): string[] {
  if (valores.length < 2) return []
  const passo = largura / (valores.length - 1)
  const y = (v: number) => altura - (Math.max(0, Math.min(maximo, v)) / maximo) * altura

  const trechos: string[] = []
  let atual: string[] = []
  valores.forEach((v, i) => {
    if (v === null) {
      if (atual.length > 1) trechos.push(atual.join(' '))
      atual = []
      return
    }
    const ponto = `${(i * passo).toFixed(1)},${y(v).toFixed(1)}`
    atual.push(atual.length === 0 ? `M${ponto}` : `L${ponto}`)
  })
  if (atual.length > 1) trechos.push(atual.join(' '))
  return trechos
}

/** Percentual de uso a partir de total e livre. `null` quando não dá para saber. */
export function usoDoVolume(
  total: number | null | undefined,
  livre: number | null | undefined,
): number | null {
  if (!total || total <= 0 || livre === null || livre === undefined || livre < 0) return null
  return Math.round(((total - livre) / total) * 100)
}

/**
 * Quanto tempo até o volume encher, no ritmo observado.
 *
 * `null` quando não dá para dizer: dado insuficiente, ou o disco está esvaziando.
 * É a informação mais acionável que a série de disco produz — "este volume enche
 * em quatro dias" move alguém hoje, "está com 88%" não move ninguém.
 *
 * Deliberadamente grosseira: reta entre o primeiro e o último ponto, sem
 * regressão. Uma projeção sofisticada daria uma falsa precisão sobre um número
 * que serve para decidir se vale olhar a máquina esta semana.
 */
export function diasAteEncher(
  pontos: { hora: string; total: number; livre: number }[],
): number | null {
  if (pontos.length < 2) return null
  const ordenados = [...pontos].sort(
    (a, b) => new Date(a.hora).getTime() - new Date(b.hora).getTime(),
  )
  const primeiro = ordenados[0]!
  const ultimo = ordenados[ordenados.length - 1]!

  const horas = (new Date(ultimo.hora).getTime() - new Date(primeiro.hora).getTime()) / 3_600_000
  if (horas < 12) return null // janela curta demais para projetar qualquer coisa

  const consumido = primeiro.livre - ultimo.livre
  if (consumido <= 0) return null // estável ou esvaziando

  const porHora = consumido / horas
  const dias = ultimo.livre / porHora / 24
  if (!Number.isFinite(dias) || dias > 365) return null
  return Math.max(0, Math.round(dias))
}
