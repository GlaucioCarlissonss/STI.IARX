import { describe, expect, it } from 'vitest'
import {
  compararInventarios,
  desdeQuando,
  formatarBytes,
  ingestaoSchema,
  inscricaoSchema,
  inventarioSchema,
  resumoDeHardware,
} from './inventario'

/**
 * Este arquivo é a metade em TypeScript do contrato que o agente em Go escreve.
 * As duas pontas não compartilham código, só o documento — então o que garante
 * que elas continuem falando a mesma língua são estas asserções mais as do
 * pacote `coleta` em Go.
 */

describe('inventarioSchema', () => {
  it('aceita um inventário mínimo: só o hostname', () => {
    /*
     * É a propriedade que faz inventário parcial ser melhor que inventário
     * nenhum. Contêiner não tem chassi, servidor mínimo não tem `dmidecode`,
     * máquina virtual não tem número de série — um schema que exigisse tudo
     * recusaria a coleta inteira por causa de um campo.
     */
    const r = inventarioSchema.safeParse({ sistema: { hostname: 'NOTE-1' } })
    expect(r.success).toBe(true)
  })

  it('recusa inventário sem hostname', () => {
    // O único campo obrigatório: sem ele não há nem como mostrar a máquina numa
    // lista, e uma linha sem nome nenhum na tela é pior que a recusa.
    expect(inventarioSchema.safeParse({ sistema: {} }).success).toBe(false)
    expect(inventarioSchema.safeParse({ sistema: { hostname: '' } }).success).toBe(false)
    expect(inventarioSchema.safeParse({}).success).toBe(false)
  })

  it('não guarda nada sobre volumes — isso é da série temporal', () => {
    /*
     * O inventário não tem lista de volumes (ver o comentário no schema). O que
     * esta asserção prova é que um agente antigo, de uma versão que ainda
     * mandava a lista, NÃO consegue fazê-la entrar: `strip` é o padrão do zod,
     * então o campo é descartado em silêncio e o hash do conteúdo continua
     * estável.
     *
     * Sem isso, uma frota com versões misturadas do agente teria metade das
     * máquinas gravando um snapshot novo a cada coleta.
     */
    const r = inventarioSchema.safeParse({
      sistema: { hostname: 'X' },
      volumes: [{ ponto: '/', total_bytes: 1000, livre_bytes: 500 }],
    })
    expect(r.success).toBe(true)
    expect(r.success && r.data).not.toHaveProperty('volumes')
  })

  it('descarta o tempo ligado que um agente antigo ainda mande', () => {
    /*
     * O campo saiu do inventário porque muda a cada segundo, e tudo no inventário
     * é hasheado para decidir se ele mudou — com ele, TODA coleta virava um
     * snapshot novo.
     *
     * O schema continua aceitando e descartando (`strip` é o padrão do zod): numa
     * frota com versões misturadas do agente, recusar o envio deixaria metade das
     * máquinas sem inventário, e aceitar o campo as deixaria gravando um snapshot
     * por coleta. Descartar é a única das três que não quebra nada.
     */
    const r = inventarioSchema.safeParse({
      sistema: { hostname: 'X', tempo_ligado_s: 123456 },
    })
    expect(r.success).toBe(true)
    expect(r.success && r.data.sistema).not.toHaveProperty('tempo_ligado_s')
  })

  it('recusa lista de software grande demais', () => {
    // Sem teto, um inventário vira uma requisição de dezenas de megabytes.
    const muitos = Array.from({ length: 5001 }, (_, i) => ({ nome: `p${i}` }))
    expect(
      inventarioSchema.safeParse({ sistema: { hostname: 'X' }, software: muitos }).success,
    ).toBe(false)
  })

  it('recusa sistema operacional que não é um dos três', () => {
    expect(
      inventarioSchema.safeParse({ sistema: { hostname: 'X', os: 'freebsd' } }).success,
    ).toBe(false)
  })

  it('aceita a data de instalação só em AAAA-MM-DD', () => {
    const bom = inventarioSchema.safeParse({
      sistema: { hostname: 'X' },
      software: [{ nome: 'App', instalado_em: '2024-01-15' }],
    })
    expect(bom.success).toBe(true)

    // O registro do Windows grava oito dígitos sem separador. Quem converte é o
    // agente; deixar passar aqui gravaria "20240115" como se fosse data.
    const ruim = inventarioSchema.safeParse({
      sistema: { hostname: 'X' },
      software: [{ nome: 'App', instalado_em: '20240115' }],
    })
    expect(ruim.success).toBe(false)
  })
})

describe('ingestaoSchema', () => {
  it('a hora da coleta fica FORA do inventário', () => {
    /*
     * É a decisão de que depende todo o desenho de "inventário igual não vira
     * linha nova". O hash é calculado sobre `inventario`; um carimbo de hora lá
     * dentro faria toda coleta parecer diferente de toda coleta.
     */
    const r = ingestaoSchema.safeParse({
      coletado_em: '2026-01-01T03:00:00.000Z',
      inventario: { sistema: { hostname: 'NOTE-1' } },
    })
    expect(r.success).toBe(true)
    expect(r.success && r.data.inventario).not.toHaveProperty('coletado_em')
  })

  it('funciona sem a hora — quem envia pode omitir', () => {
    expect(
      ingestaoSchema.safeParse({ inventario: { sistema: { hostname: 'X' } } }).success,
    ).toBe(true)
  })
})

describe('inscricaoSchema', () => {
  it('exige um UUID de verdade na identidade da máquina', () => {
    // O `device_uuid` é a chave de unicidade da máquina no banco. Texto livre ali
    // permitiria duas "máquinas" com a identidade "teste".
    expect(
      inscricaoSchema.safeParse({
        enrollment_token: 'inv_0123456789abcdef',
        device: { device_uuid: 'nao-e-uuid' },
      }).success,
    ).toBe(false)

    expect(
      inscricaoSchema.safeParse({
        enrollment_token: 'inv_0123456789abcdef',
        device: { device_uuid: '11111111-1111-4111-8111-111111111111' },
      }).success,
    ).toBe(true)
  })

  it('recusa token de inscrição curto demais para ser um segredo', () => {
    expect(
      inscricaoSchema.safeParse({
        enrollment_token: 'inv_123',
        device: { device_uuid: '11111111-1111-4111-8111-111111111111' },
      }).success,
    ).toBe(false)
  })
})

describe('formatarBytes', () => {
  it('não usa casa decimal a partir de GB', () => {
    /*
     * "16 GB" é o que está escrito na caixa do pente de memória. "15,9 GB" — que é
     * o número verdadeiro, porque o sistema reserva uma parte — faz quem confere o
     * inventário achar que está faltando memória, e abrir um chamado.
     */
    expect(formatarBytes(17_179_869_184)).toBe('16 GB')
    expect(formatarBytes(512 * 1024 ** 3)).toBe('512 GB')
    expect(formatarBytes(2 * 1024 ** 4)).toBe('2 TB')
  })

  it('usa vírgula decimal, e uma casa só abaixo de 10', () => {
    expect(formatarBytes(1536)).toBe('1,5 KB')
    expect(formatarBytes(15 * 1024)).toBe('15 KB')
  })

  it('devolve travessão para ausência, e não "0 B"', () => {
    // "0 B de memória" seria lido como um defeito da máquina; o travessão diz
    // "não sei", que é a verdade.
    expect(formatarBytes(null)).toBe('—')
    expect(formatarBytes(undefined)).toBe('—')
    expect(formatarBytes(0)).toBe('—')
  })
})

describe('desdeQuando', () => {
  const agora = Date.now()
  const atras = (ms: number) => new Date(agora - ms).toISOString()

  it('diz "nunca" quando a máquina jamais falou', () => {
    // Distinguir "nunca" de "há muito tempo" importa: nunca é instalação que não
    // completou; há muito tempo é máquina que parou.
    expect(desdeQuando(null)).toBe('nunca')
    expect(desdeQuando(undefined)).toBe('nunca')
  })

  it('escolhe a unidade pela ordem de grandeza', () => {
    expect(desdeQuando(atras(30_000))).toBe('agora')
    expect(desdeQuando(atras(5 * 60_000))).toBe('há 5 min')
    expect(desdeQuando(atras(3 * 3_600_000))).toBe('há 3 h')
    expect(desdeQuando(atras(2 * 86_400_000))).toBe('há 2 dias')
    expect(desdeQuando(atras(86_400_000))).toBe('há 1 dia')
  })
})

describe('resumoDeHardware', () => {
  it('junta processador, memória e disco numa linha', () => {
    const texto = resumoDeHardware({
      sistema: { hostname: 'X' },
      processador: { modelo: 'Intel(R) Core(TM) i7-1165G7 CPU @ 2.80GHz' },
      memoria: { total_bytes: 17_179_869_184 },
      discos: [{ tamanho_bytes: 256 * 1024 ** 3 }, { tamanho_bytes: 256 * 1024 ** 3 }],
    })
    expect(texto).toContain('16 GB RAM')
    expect(texto).toContain('512 GB')
    // `(R)`, `(TM)` e `CPU ` saem: ocupam um terço da coluna e não dizem nada.
    expect(texto).not.toContain('(R)')
    expect(texto).not.toContain('(TM)')
  })

  it('soma os discos em vez de mostrar o primeiro', () => {
    // Um servidor com seis discos de 2 TB tem 12 TB, não 2 TB. Mostrar o primeiro
    // faria o inventário subdimensionar o parque inteiro.
    expect(resumoDeHardware({ sistema: { hostname: 'X' }, discos: [{ tamanho_bytes: 1024 ** 4 }, { tamanho_bytes: 1024 ** 4 }] })).toBe('2 TB')
  })

  it('devolve vazio quando não há nada, e não "desconhecido"', () => {
    expect(resumoDeHardware({ sistema: { hostname: 'X' } })).toBe('')
    expect(resumoDeHardware(null)).toBe('')
    expect(resumoDeHardware('nem é objeto')).toBe('')
  })
})

describe('compararInventarios', () => {
  const base = {
    sistema: { hostname: 'NOTE-1', usuario_logado: 'jsilva', os_version: 'Windows 11 22H2' },
    memoria: { total_bytes: 17_179_869_184 },
    discos: [{ modelo: 'Samsung 980', tamanho_bytes: 512 * 1024 ** 3, saude: 'ok' as const }],
  }

  it('memória que sumiu é a primeira coisa que ele diz', () => {
    /*
     * É a pergunta que paga o módulo: pente de RAM que some entre uma coleta e
     * outra ou é defeito ou é furto, e nos dois casos alguém precisa saber hoje —
     * não no inventário anual.
     */
    const mudancas = compararInventarios(base, {
      ...base,
      memoria: { total_bytes: 8_589_934_592 },
    })
    expect(mudancas.some((m) => m.includes('Memória caiu de 16 GB para 8 GB'))).toBe(true)
  })

  it('memória a mais também aparece, com a palavra certa', () => {
    const mudancas = compararInventarios(base, {
      ...base,
      memoria: { total_bytes: 34_359_738_368 },
    })
    expect(mudancas.some((m) => m.includes('subiu'))).toBe(true)
  })

  it('um disco a menos entre dois é relatado', () => {
    const mudancas = compararInventarios(
      { ...base, discos: [...base.discos, { tamanho_bytes: 1024 ** 4 }] },
      base,
    )
    expect(mudancas.some((m) => m.includes('deixou de aparecer'))).toBe(true)
  })

  it('mas a lista ficar VAZIA não é relatado como disco removido', () => {
    /*
     * Lista vazia quase sempre é a coleta que falhou, não a máquina que ficou sem
     * disco — uma máquina sem disco nenhum não teria coletado nada para enviar.
     *
     * É uma escolha com custo: o caso raro de o último disco morrer de verdade
     * passa calado aqui. Em troca, não há um alarme por máquina toda vez que a
     * consulta de disco der timeout — e alarme falso é o que faz a pessoa parar de
     * olhar para os verdadeiros.
     */
    expect(compararInventarios(base, { ...base, discos: [] })).toEqual([])
  })

  it('SMART em falha aparece mesmo sem nada mais ter mudado', () => {
    const mudancas = compararInventarios(base, {
      ...base,
      discos: [{ ...base.discos[0]!, saude: 'falha' as const }],
    })
    expect(mudancas.some((m) => m.includes('SMART') && m.includes('falha'))).toBe(true)
  })

  it('troca de usuário e renomeação da máquina aparecem', () => {
    const mudancas = compararInventarios(base, {
      ...base,
      sistema: { ...base.sistema, usuario_logado: 'mcosta', hostname: 'NOTE-FISCAL' },
    })
    expect(mudancas.some((m) => m.includes('jsilva') && m.includes('mcosta'))).toBe(true)
    expect(mudancas.some((m) => m.includes('renomeada'))).toBe(true)
  })

  it('inventário igual não produz mudança nenhuma', () => {
    // Numa frota estável é o resultado normal, e a tela diz isso com todas as
    // letras em vez de mostrar uma lista vazia sem explicação.
    expect(compararInventarios(base, base)).toEqual([])
  })

  it('campo que apareceu agora não conta como mudança', () => {
    /*
     * A consulta que lê a memória falha por timeout numa coleta e funciona na
     * seguinte — acontece. Tratar isso como "a memória mudou de nada para 16 GB"
     * encheria o histórico de alarme falso, e alarme falso é o que faz a pessoa
     * parar de olhar.
     */
    const semMemoria = { sistema: base.sistema }
    expect(compararInventarios(semMemoria, base)).toEqual([])
    expect(compararInventarios(base, semMemoria)).toEqual([])
  })

  it('não quebra com entrada que não é inventário', () => {
    expect(compararInventarios(null, undefined)).toEqual([])
    expect(compararInventarios('texto', 42)).toEqual([])
  })
})
