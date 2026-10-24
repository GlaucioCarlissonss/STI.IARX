import { describe, expect, it } from 'vitest'
import {
  amostraSchema,
  completarHoras,
  diasAteEncher,
  loteDeMetricasSchema,
  trechosDaLinha,
  usoDoVolume,
  type PontoDoGrafico,
} from './metricas'

const ponto = (hora: string, cpu: number | null, max: number | null = cpu): PontoDoGrafico => ({
  hora,
  cpu_avg: cpu,
  cpu_max: max,
  mem_avg_pct: cpu,
  mem_max_pct: max,
})

describe('amostraSchema', () => {
  it('aceita uma amostra mínima', () => {
    expect(amostraSchema.safeParse({ em: '2026-01-01T12:00:00.000Z' }).success).toBe(true)
  })

  it('recusa amostra sem hora', () => {
    // Sem o carimbo, a amostra não tem lugar na série — e a chave primária do
    // servidor é (máquina, hora).
    expect(amostraSchema.safeParse({ cpu: 50 }).success).toBe(false)
    expect(amostraSchema.safeParse({ em: 'ontem', cpu: 50 }).success).toBe(false)
  })

  it('recusa CPU fora de 0–100', () => {
    const base = { em: '2026-01-01T12:00:00.000Z' }
    expect(amostraSchema.safeParse({ ...base, cpu: 101 }).success).toBe(false)
    expect(amostraSchema.safeParse({ ...base, cpu: -1 }).success).toBe(false)
    expect(amostraSchema.safeParse({ ...base, cpu: 0 }).success).toBe(true)
    expect(amostraSchema.safeParse({ ...base, cpu: 100 }).success).toBe(true)
  })

  it('recusa volume sem tamanho', () => {
    // Um volume com total zero não tem percentual de uso: a divisão por zero
    // viraria `Infinity` e o alerta de disco abriria em toda máquina.
    const base = { em: '2026-01-01T12:00:00.000Z' }
    expect(
      amostraSchema.safeParse({ ...base, volumes: [{ ponto: '/', total: 0, livre: 0 }] }).success,
    ).toBe(false)
  })
})

describe('loteDeMetricasSchema', () => {
  it('exige pelo menos uma amostra', () => {
    expect(loteDeMetricasSchema.safeParse({ amostras: [] }).success).toBe(false)
  })

  it('recusa lote grande demais', () => {
    /*
     * Sem o teto, a fila represada de um mês viraria uma requisição que o
     * servidor corta no meio — deixando metade gravada e nenhum registro de onde
     * parou. 500 amostras são quase dois dias a cinco minutos.
     */
    const muitas = Array.from({ length: 501 }, () => ({ em: '2026-01-01T12:00:00.000Z' }))
    expect(loteDeMetricasSchema.safeParse({ amostras: muitas }).success).toBe(false)
  })
})

describe('completarHoras', () => {
  const agora = new Date('2026-01-01T12:34:00.000Z')

  it('devolve exatamente a quantidade de horas pedida', () => {
    expect(completarHoras([], 24, agora)).toHaveLength(24)
  })

  it('preenche com nulo a hora que não teve amostra', () => {
    /*
     * É a propriedade que faz o buraco parecer um buraco. Sem ela, o gráfico
     * ligaria por uma reta a última medição antes de a máquina desligar com a
     * primeira depois de ela voltar — e reta num gráfico de CPU é lida como
     * "ficou constante", que é o contrário de "estava desligada".
     */
    const saida = completarHoras([ponto('2026-01-01T12:00:00.000Z', 40)], 3, agora)
    expect(saida.map((p) => p.cpu_avg)).toEqual([null, null, 40])
  })

  it('a última posição é a hora corrente', () => {
    const saida = completarHoras([], 3, agora)
    expect(saida[saida.length - 1]!.hora).toBe('2026-01-01T12:00:00.000Z')
    expect(saida[0]!.hora).toBe('2026-01-01T10:00:00.000Z')
  })

  it('ignora amostra fora da janela em vez de deslocar a série', () => {
    const saida = completarHoras(
      [ponto('2026-01-01T12:00:00.000Z', 40), ponto('2025-12-01T00:00:00.000Z', 99)],
      3,
      agora,
    )
    expect(saida).toHaveLength(3)
    expect(saida.some((p) => p.cpu_avg === 99)).toBe(false)
  })
})

describe('trechosDaLinha', () => {
  it('desenha uma linha contínua quando há dado em tudo', () => {
    const trechos = trechosDaLinha([0, 50, 100], 100, 10)
    expect(trechos).toHaveLength(1)
    // 0% fica na base (y = altura), 100% no topo (y = 0).
    expect(trechos[0]).toBe('M0.0,10.0 L50.0,5.0 L100.0,0.0')
  })

  it('PARTE a linha onde não há dado', () => {
    // É o buraco, no DOM: dois caminhos separados em vez de um `d` com `M` no
    // meio — assim o buraco é inspecionável e estilizável por trecho.
    const trechos = trechosDaLinha([10, 20, null, 40, 50], 100, 10)
    expect(trechos).toHaveLength(2)
    expect(trechos[0]!.startsWith('M')).toBe(true)
    expect(trechos[1]!.startsWith('M')).toBe(true)
  })

  it('descarta trecho de um ponto só — não há linha a desenhar', () => {
    expect(trechosDaLinha([10, null, 30, null], 100, 10)).toEqual([])
    expect(trechosDaLinha([42], 100, 10)).toEqual([])
    expect(trechosDaLinha([], 100, 10)).toEqual([])
  })

  it('não deixa o traço escapar da moldura', () => {
    // Uma leitura de 120% (relógio ou contador maluco) desenharia acima do topo
    // e vazaria para fora do SVG, por cima do texto ao lado.
    const trechos = trechosDaLinha([-20, 120], 100, 10)
    expect(trechos[0]).toBe('M0.0,10.0 L100.0,0.0')
  })
})

describe('usoDoVolume', () => {
  it('calcula o percentual de uso', () => {
    expect(usoDoVolume(1000, 100)).toBe(90)
    expect(usoDoVolume(1000, 1000)).toBe(0)
    expect(usoDoVolume(1000, 0)).toBe(100)
  })

  it('devolve nulo em vez de dividir por zero', () => {
    // Volume com total zero existe (ponto de montagem recém-criado, sistema de
    // arquivos virtual que escapou do filtro). `Infinity` no percentual abriria
    // alerta de disco em toda máquina.
    expect(usoDoVolume(0, 0)).toBeNull()
    expect(usoDoVolume(null, 100)).toBeNull()
    expect(usoDoVolume(1000, null)).toBeNull()
    expect(usoDoVolume(1000, undefined)).toBeNull()
  })
})

describe('diasAteEncher', () => {
  const serie = (pares: [number, number][]) =>
    pares.map(([horasAtras, livre]) => ({
      hora: new Date(Date.now() - horasAtras * 3_600_000).toISOString(),
      total: 1_000_000,
      livre,
    }))

  it('projeta pelo ritmo observado', () => {
    /*
     * É a informação mais acionável que a série de disco produz: "este volume
     * enche em quatro dias" move alguém hoje; "está com 88%" não move ninguém.
     *
     * 100 mil bytes consumidos em 48 h, sobrando 100 mil → mais 48 h → 2 dias.
     */
    expect(diasAteEncher(serie([[48, 200_000], [0, 100_000]]))).toBe(2)
  })

  it('devolve nulo quando o disco está estável ou esvaziando', () => {
    // Projetar sobre consumo zero ou negativo daria infinito ou uma data no
    // passado, e as duas apareceriam na tela como fato.
    expect(diasAteEncher(serie([[48, 100_000], [0, 100_000]]))).toBeNull()
    expect(diasAteEncher(serie([[48, 100_000], [0, 300_000]]))).toBeNull()
  })

  it('devolve nulo com janela curta demais', () => {
    /*
     * Duas medições separadas por uma hora não projetam nada: alguém baixou um
     * arquivo grande e a projeção diria que o disco enche amanhã. Doze horas é o
     * mínimo para a reta significar alguma coisa.
     */
    expect(diasAteEncher(serie([[1, 200_000], [0, 100_000]]))).toBeNull()
    expect(diasAteEncher(serie([[0, 100_000]]))).toBeNull()
    expect(diasAteEncher([])).toBeNull()
  })

  it('devolve nulo quando a projeção passa de um ano', () => {
    // "Enche em 3.400 dias" é ruído com cara de informação: ocupa a coluna e não
    // diz nada que "estável" não diga melhor.
    expect(diasAteEncher(serie([[72, 100_010], [0, 100_000]]))).toBeNull()
  })

  it('não depende da ordem em que os pontos chegam', () => {
    const fora = serie([[0, 100_000], [48, 200_000]])
    expect(diasAteEncher(fora)).toBe(2)
  })
})
