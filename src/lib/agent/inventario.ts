import { z } from 'zod'

/**
 * O contrato entre o agente e o servidor.
 *
 * Ele está em um arquivo só porque é lido de três lugares: a rota que recebe, a
 * tela que mostra, e o agente em Go que monta (que não compartilha código com
 * isto, mas compartilha o documento — `agente/README.md` aponta para cá).
 *
 * ## Por que os nomes dos campos estão em português
 *
 * Porque o resto do schema está. `numero_serie` ao lado de `serial_number` em
 * `it_assets` é feio, e é a escolha certa: o payload é documento de domínio, lido
 * por quem opera; a coluna é modelo de dados, lido por quem desenvolve. Misturar
 * para "ficar uniforme" obrigaria a traduzir em um dos dois lados de qualquer
 * jeito, e traduzir no lugar errado é onde moram os defeitos de inventário.
 *
 * ## Por que quase tudo é opcional
 *
 * Porque a máquina mente, ou cala. Placa-mãe sem WMI íntegro não devolve a BIOS,
 * container não tem chassi, Linux sem `dmidecode` não lê número de série,
 * servidor com RAID não mostra disco individual. Um schema que exigisse tudo
 * recusaria o inventário inteiro por causa de um campo — e inventário parcial é
 * incomparavelmente melhor que inventário nenhum.
 *
 * O que **não** é opcional é o `hostname`: sem ele não há nem como mostrar a
 * máquina numa lista, e uma linha sem nome nenhum na tela de frota é pior que a
 * recusa.
 */

const textoCurto = z.string().trim().max(200)
const textoLongo = z.string().trim().max(300)

export const sistemaSchema = z.object({
  hostname: z.string().trim().min(1).max(120),
  os: z.enum(['windows', 'linux', 'darwin']).optional(),
  os_version: textoCurto.optional(),
  os_build: textoCurto.optional(),
  /* `vm` existe e não vira tipo de ativo: máquina virtual não é patrimônio, e
     criar um ativo 'notebook' para um contêiner sujaria o inventário físico. */
  chassi: z.enum(['notebook', 'desktop', 'server', 'vm', 'desconhecido']).optional(),
  fabricante: textoCurto.optional(),
  modelo: textoCurto.optional(),
  numero_serie: textoCurto.optional(),
  service_tag: textoCurto.optional(),
  dominio: textoCurto.optional(),
  usuario_logado: textoCurto.optional(),
  /* Em segundos. Fica no inventário e não nas métricas porque "esta máquina está
     ligada há 240 dias" é um fato de configuração (ninguém reinicia, então ninguém
     aplica atualização), não uma amostra de desempenho. */
  tempo_ligado_s: z.number().int().nonnegative().optional(),
})

export const memoriaSchema = z.object({
  total_bytes: z.number().int().nonnegative().optional(),
  pentes: z
    .array(
      z.object({
        slot: textoCurto.optional(),
        tamanho_bytes: z.number().int().nonnegative().optional(),
        tipo: textoCurto.optional(),
        velocidade_mhz: z.number().int().nonnegative().optional(),
        fabricante: textoCurto.optional(),
      }),
    )
    .max(64)
    .optional(),
})

export const discoSchema = z.object({
  dispositivo: textoCurto.optional(),
  modelo: textoCurto.optional(),
  tamanho_bytes: z.number().int().nonnegative().optional(),
  tipo: z.enum(['hdd', 'ssd', 'nvme', 'desconhecido']).optional(),
  /* SMART resumido a três estados em vez dos 30 atributos crus: a pergunta que a
     tela responde é "preciso trocar este disco?", e 30 contadores não respondem
     essa pergunta para ninguém que não seja especialista. Os atributos crus ficam
     no payload para quem quiser, mas não dirigem a tela. */
  saude: z.enum(['ok', 'atencao', 'falha', 'desconhecido']).optional(),
  atributos_smart: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})

export const inventarioSchema = z.object({
  sistema: sistemaSchema,
  processador: z
    .object({
      modelo: textoCurto.optional(),
      nucleos: z.number().int().nonnegative().max(1024).optional(),
      threads: z.number().int().nonnegative().max(4096).optional(),
      frequencia_mhz: z.number().int().nonnegative().optional(),
      arquitetura: textoCurto.optional(),
    })
    .optional(),
  memoria: memoriaSchema.optional(),
  discos: z.array(discoSchema).max(64).optional(),
  /*
   * Volume NÃO tem `livre_bytes`, e a ausência é deliberada.
   *
   * Espaço livre é métrica, não configuração: muda a cada hora. Aceitá-lo aqui
   * faria o hash do conteúdo mudar a cada coleta, e o histórico — que existe para
   * responder "o que mudou nesta máquina?" — viraria 365 linhas por ano por
   * máquina dizendo "o disco está um pouco mais cheio". O tamanho total fica,
   * porque esse é configuração. O livre é da série temporal da Onda 3.
   */
  volumes: z
    .array(
      z.object({
        ponto: textoCurto.optional(),
        sistema_arquivos: textoCurto.optional(),
        total_bytes: z.number().int().nonnegative().optional(),
      }),
    )
    .max(64)
    .optional(),
  rede: z
    .array(
      z.object({
        nome: textoCurto.optional(),
        mac: textoCurto.optional(),
        ips: z.array(textoCurto).max(16).optional(),
        tipo: textoCurto.optional(),
      }),
    )
    .max(32)
    .optional(),
  video: z
    .array(
      z.object({
        modelo: textoCurto.optional(),
        memoria_bytes: z.number().int().nonnegative().optional(),
        driver: textoCurto.optional(),
      }),
    )
    .max(8)
    .optional(),
  bios: z
    .object({
      fabricante: textoCurto.optional(),
      versao: textoCurto.optional(),
      data: textoCurto.optional(),
      modo: z.enum(['uefi', 'legacy', 'desconhecido']).optional(),
      secure_boot: z.boolean().optional(),
    })
    .optional(),
  software: z
    .array(
      z.object({
        nome: textoLongo.min(1),
        versao: textoCurto.optional(),
        fabricante: textoCurto.optional(),
        instalado_em: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    /* Teto de 5.000: uma estação de desenvolvimento com gerenciador de pacotes
       chega a milhares de entradas, e sem teto um inventário vira uma requisição
       de dezenas de megabytes. */
    .max(5000)
    .optional(),
  agente: z
    .object({
      versao: textoCurto.optional(),
      plataforma: textoCurto.optional(),
    })
    .optional(),
})

export const ingestaoSchema = z.object({
  /* Separado do inventário de propósito: o hash de conteúdo é calculado sobre
     `inventario`, e um carimbo de hora lá dentro faria todo inventário parecer
     diferente de todo inventário — ver a decisão 4 da migração 0031. */
  coletado_em: z.string().datetime().optional(),
  inventario: inventarioSchema,
})

export const inscricaoSchema = z.object({
  enrollment_token: z.string().trim().min(16).max(200),
  device: z.object({
    device_uuid: z.string().uuid(),
    hostname: z.string().trim().min(1).max(120).optional(),
    os: z.enum(['windows', 'linux', 'darwin']).optional(),
    os_version: textoCurto.optional(),
    chassis: z.enum(['notebook', 'desktop', 'server', 'vm', 'desconhecido']).optional(),
    agent_version: textoCurto.optional(),
  }),
})

export type Inventario = z.infer<typeof inventarioSchema>

/** Bytes legíveis. Usada na tela de frota e no detalhe da máquina. */
export function formatarBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes <= 0) return '—'
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB']
  let valor = bytes
  let i = 0
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024
    i += 1
  }
  /* Sem casa decimal a partir de GB: "16 GB" é o que está escrito na caixa do
     pente de memória, e "15,9 GB" (que é o número verdadeiro, porque o sistema
     reserva uma parte) faz quem confere achar que falta memória. */
  const casas = i >= 3 ? 0 : valor < 10 ? 1 : 0
  return `${valor.toFixed(casas).replace('.', ',')} ${unidades[i]}`
}

/** Há quanto tempo, em palavras. `null` quando a máquina nunca falou. */
export function desdeQuando(iso: string | null | undefined): string {
  if (!iso) return 'nunca'
  const ms = Date.now() - new Date(iso).getTime()
  const minutos = Math.floor(ms / 60_000)
  if (minutos < 1) return 'agora'
  if (minutos < 60) return `há ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `há ${horas} h`
  const dias = Math.floor(horas / 24)
  return `há ${dias} ${dias === 1 ? 'dia' : 'dias'}`
}

/**
 * Resumo de uma linha para a lista: processador, memória, disco.
 *
 * Devolve string vazia em vez de "desconhecido" quando não há nada: a coluna
 * fica vazia, e vazio comunica "não sei" melhor que uma palavra que ocupa o
 * mesmo espaço de um dado de verdade.
 */
export function resumoDeHardware(inv: unknown): string {
  const r = inventarioSchema.partial().safeParse(inv)
  if (!r.success) return ''
  const partes: string[] = []
  const cpu = r.data.processador?.modelo
  if (cpu) partes.push(cpu.replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU /g, '').trim())
  const ram = r.data.memoria?.total_bytes
  if (ram) partes.push(`${formatarBytes(ram)} RAM`)
  const disco = (r.data.discos ?? []).reduce((s, d) => s + (d.tamanho_bytes ?? 0), 0)
  if (disco > 0) partes.push(formatarBytes(disco))
  return partes.join(' · ')
}

/**
 * O que mudou entre dois inventários, em linguagem de gente.
 *
 * É a razão de `agent_inventory_snapshots` guardar o inventário inteiro em vez
 * de só os campos de interesse: a comparação é feita aqui, depois, e acrescentar
 * um campo à comparação não exige migrar dado nenhum.
 *
 * A lista é curta de propósito. Comparar tudo produziria dezenas de linhas por
 * mudança de versão de driver, e enterraria o que importa: memória que sumiu,
 * disco que sumiu, máquina que trocou de dono.
 */
export function compararInventarios(anterior: unknown, atual: unknown): string[] {
  const a = inventarioSchema.partial().safeParse(anterior)
  const b = inventarioSchema.partial().safeParse(atual)
  if (!a.success || !b.success) return []
  const mudancas: string[] = []

  const ramA = a.data.memoria?.total_bytes ?? 0
  const ramB = b.data.memoria?.total_bytes ?? 0
  if (ramA > 0 && ramB > 0 && ramA !== ramB) {
    mudancas.push(
      ramB < ramA
        ? `Memória caiu de ${formatarBytes(ramA)} para ${formatarBytes(ramB)}`
        : `Memória subiu de ${formatarBytes(ramA)} para ${formatarBytes(ramB)}`,
    )
  }

  const discoA = (a.data.discos ?? []).length
  const discoB = (b.data.discos ?? []).length
  if (discoA > 0 && discoB > 0 && discoA !== discoB) {
    mudancas.push(
      discoB < discoA
        ? `Um disco deixou de aparecer (${discoA} → ${discoB})`
        : `Disco novo instalado (${discoA} → ${discoB})`,
    )
  }

  for (const d of b.data.discos ?? []) {
    if (d.saude === 'falha' || d.saude === 'atencao') {
      mudancas.push(`Disco ${d.modelo ?? d.dispositivo ?? ''} com SMART em "${d.saude}"`.trim())
    }
  }

  const usuarioA = a.data.sistema?.usuario_logado
  const usuarioB = b.data.sistema?.usuario_logado
  if (usuarioA && usuarioB && usuarioA !== usuarioB) {
    mudancas.push(`Usuário logado mudou de ${usuarioA} para ${usuarioB}`)
  }

  const soA = a.data.sistema?.os_version
  const soB = b.data.sistema?.os_version
  if (soA && soB && soA !== soB) {
    mudancas.push(`Sistema operacional atualizado: ${soA} → ${soB}`)
  }

  const nomeA = a.data.sistema?.hostname
  const nomeB = b.data.sistema?.hostname
  if (nomeA && nomeB && nomeA !== nomeB) {
    mudancas.push(`Máquina renomeada de ${nomeA} para ${nomeB}`)
  }

  return mudancas
}
