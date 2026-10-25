import type { TransformKind } from './mapping'

/**
 * O vocabulário do mapeamento, como a tela precisa dele.
 *
 * Mora fora de `mapping.ts` de propósito: aquele arquivo é o MOTOR, sem
 * dependência nenhuma, importado por caminho relativo dentro das Edge Functions
 * (Deno). Rótulo em português e texto de ajuda são assunto da tela, e carregá-los
 * para dentro do motor os levaria junto para o Deno sem necessidade.
 *
 * E mora fora da Server Action porque **um módulo `'use server'` só pode
 * exportar funções assíncronas** — exportar uma constante de lá compila e
 * derruba a rota em tempo de execução, com uma mensagem que não aponta para a
 * causa. Já aconteceu nesta base, em `/conta`.
 */

/**
 * Os campos do chamado que um mapeamento pode preencher.
 *
 * É uma lista fechada, e não texto livre, porque **`target_field` errado não dá
 * erro**: o motor escreve a chave no objeto, nada reclama, e o chamado nasce com
 * o campo de verdade em branco. O estrago aparece semanas depois, quando alguém
 * procura um chamado pelo campo que nunca foi preenchido.
 */
export const CAMPOS_DE_TICKET = [
  'title',
  'description',
  'status',
  'priority_key',
  'queue_id',
  'requester_id',
  'assignee_id',
  'deadline',
  'created_at',
  'tags',
  'external_id',
  'external_url',
] as const

export type CampoDeTicket = (typeof CAMPOS_DE_TICKET)[number]

export const ROTULO_DO_CAMPO: Record<CampoDeTicket, string> = {
  title: 'Título',
  description: 'Descrição',
  status: 'Situação',
  priority_key: 'Prioridade (chave)',
  queue_id: 'Fila',
  requester_id: 'Solicitante',
  assignee_id: 'Responsável',
  deadline: 'Prazo',
  created_at: 'Aberto em',
  tags: 'Etiquetas',
  external_id: 'ID no sistema de origem',
  external_url: 'Link no sistema de origem',
}

export const TRANSFORMACOES = [
  'direct',
  'html_to_text',
  'datetime',
  'value_map',
  'constant',
  'user_by_email',
  'user_by_external_id',
  'queue_by_external_id',
] as const

export const DESCRICAO_DA_TRANSFORMACAO: Record<TransformKind, string> = {
  direct: 'Copia o valor como veio. Lista continua lista.',
  html_to_text: 'Tira as marcações de HTML. É o que torna uma descrição do Bitrix24 legível.',
  datetime: 'Converte a data para o formato interno. Data que não dá para entender vira erro.',
  value_map: 'De-para de valores: "em andamento" → "in_progress". Exige os pares preenchidos.',
  constant: 'Ignora o payload e grava sempre o mesmo valor, que vai no campo padrão.',
  user_by_email: 'Procura a pessoa pelo e-mail.',
  user_by_external_id: 'Procura a pessoa pelo identificador do sistema de origem.',
  queue_by_external_id: 'Procura a fila pelo identificador do sistema de origem.',
}

/** As transformações que resolvem alguma coisa no banco, em vez de converter. */
export const TRANSFORMACOES_DE_BUSCA: readonly TransformKind[] = [
  'user_by_email',
  'user_by_external_id',
  'queue_by_external_id',
]

export interface MapaLido {
  valores: Record<string, string>
}

/**
 * Lê o de-para escrito pela pessoa, uma linha por par.
 *
 * ```
 * em andamento = in_progress
 * concluído    = resolved
 * ```
 *
 * Por que `=` e não JSON: o de-para é a parte do mapeamento que mais muda, e
 * quem o edita está lendo uma lista de status num sistema de terceiros. Pedir
 * JSON válido para isso transforma vírgula esquecida em erro de sintaxe, e o
 * erro de sintaxe não diz qual status ficou faltando.
 */
export function lerMapaDeValores(texto: string): MapaLido | { erro: string } {
  const valores: Record<string, string> = {}

  for (const [i, linhaBruta] of texto.split('\n').entries()) {
    const linha = linhaBruta.trim()
    if (!linha) continue

    const corte = linha.indexOf('=')
    if (corte <= 0) {
      return {
        erro: `Linha ${i + 1} do de-para não tem "=": escreva "valor de origem = valor aqui".`,
      }
    }

    const de = linha.slice(0, corte).trim()
    const para = linha.slice(corte + 1).trim()
    if (!de || !para) {
      return { erro: `Linha ${i + 1} do de-para está pela metade.` }
    }
    /* Chave repetida é silenciosa em objeto: a última ganharia e a pessoa nunca
       saberia qual das duas estava valendo. */
    if (de in valores) {
      return { erro: `O valor de origem "${de}" aparece duas vezes no de-para.` }
    }
    valores[de] = para
  }

  return { valores }
}

/** O caminho inverso: do que está no banco para o que a pessoa edita. */
export function escreverMapaDeValores(valores: Record<string, string> | null): string {
  if (!valores) return ''
  return Object.entries(valores)
    .map(([de, para]) => `${de} = ${para}`)
    .join('\n')
}
