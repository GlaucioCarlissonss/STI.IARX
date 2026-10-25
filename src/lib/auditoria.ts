/**
 * A leitura da trilha de auditoria.
 *
 * ## O problema que esta camada resolve
 *
 * `audit_log.changes` guarda o diff cru da trigger, em três formatos diferentes
 * conforme a ação:
 *
 * ```
 * insert → { "created": { <linha inteira> } }
 * update → { "coluna": { "old": ..., "new": ... }, ... }
 * delete → { "deleted": { <linha inteira> } }
 * ```
 *
 * Mostrar isso cru é mostrar JSON para quem quer saber "quem mudou a prioridade
 * do contrato da Transportadora Alfa". A trilha existe desde a migração 0010 e
 * ninguém nunca a leu — em parte porque não havia tela, e em parte porque, sem
 * esta tradução, a tela não valeria a visita.
 */

export type AcaoDeAuditoria = 'insert' | 'update' | 'delete'

export interface LinhaDaTrilha {
  id: number
  action: string
  entity_type: string
  entity_id: string | null
  changes: Record<string, unknown>
  created_at: string
  actor: { full_name: string } | null
}

/** Uma alteração já legível: campo, de, para. */
export interface Alteracao {
  campo: string
  de: string
  para: string
}

/**
 * Como cada tabela se chama em português.
 *
 * Lista explícita, e não `entity_type.replace('_', ' ')`: `it_assets` viraria
 * "it assets", que não é melhor que o nome cru. Tabela que não estiver aqui
 * aparece com o nome técnico — é feio e é honesto, e a tela não quebra quando
 * uma migração nova acrescentar uma tabela auditada.
 */
export const NOME_DA_ENTIDADE: Record<string, string> = {
  access_profiles: 'Perfil de acesso',
  agent_alerts: 'Alerta do agente',
  agent_devices: 'Máquina com agente',
  agent_enrollments: 'Token de inscrição do agente',
  ai_settings: 'Configuração de IA',
  ai_suggestions: 'Sugestão de IA',
  approval_rules: 'Regra de alçada',
  bank_account_movements: 'Movimentação bancária',
  bank_accounts: 'Conta bancária',
  branch_areas: 'Área da filial',
  branches: 'Filial',
  business_hours: 'Expediente',
  channel_contacts: 'Contato de canal',
  channels: 'Canal de conversa',
  clients: 'Cliente',
  cost_centers: 'Centro de custo',
  integration_mappings: 'Mapeamento de integração',
  integrations: 'Integração',
  internet_link_attachments: 'Anexo de link',
  internet_links: 'Link de internet',
  it_assets: 'Ativo de TI',
  kb_articles: 'Artigo da base',
  payables: 'Título a pagar',
  permission_grants: 'Concessão de permissão',
  profiles: 'Pessoa',
  queue_members: 'Membro de fila',
  queue_rules: 'Regra de roteamento',
  queues: 'Fila',
  receivables: 'Título a receber',
  service_catalog: 'Serviço do catálogo',
  service_catalog_clients: 'Preço por cliente',
  sla_contracts: 'Contrato de SLA',
  sla_definitions: 'Definição de SLA',
  supplier_contracts: 'Contrato de fornecedor',
  suppliers: 'Fornecedor',
  telecom_lines: 'Linha telefônica',
  ticket_categories: 'Categoria de ticket',
  ticket_priorities: 'Prioridade',
  ticket_satisfaction: 'Pesquisa de satisfação',
  user_branches: 'Filial do usuário',
}

export function nomeDaEntidade(tipo: string): string {
  return NOME_DA_ENTIDADE[tipo] ?? tipo
}

export const ROTULO_DA_ACAO: Record<string, string> = {
  insert: 'criou',
  update: 'alterou',
  delete: 'apagou',
}

/**
 * Campos que nunca interessam a quem lê a trilha.
 *
 * `tenant_id` é o mesmo em toda linha que a pessoa consegue ver (o RLS garante);
 * os ids de chave estrangeira aparecem como uuid, que não diz nada a ninguém. O
 * que sobra é o que mudou de fato.
 *
 * Note que `*_id` sai da lista de campos ALTERADOS, mas não some do registro: o
 * JSON completo continua no banco, e quem precisa dele tem o `entity_id` para
 * procurar.
 */
const RUIDO = new Set(['tenant_id', 'id', 'created_at', 'updated_at', 'search_vector'])

function legivel(valor: unknown): string {
  if (valor === null || valor === undefined) return '—'
  if (typeof valor === 'boolean') return valor ? 'sim' : 'não'
  if (typeof valor === 'number') return String(valor)
  if (typeof valor === 'string') {
    if (valor === '') return '(vazio)'
    /* Texto longo cortado: a trilha mostra O QUE mudou, não o conteúdo inteiro
       de uma descrição de chamado. Quem quer o texto abre o registro. */
    return valor.length > 120 ? `${valor.slice(0, 120)}…` : valor
  }
  const json = JSON.stringify(valor)
  return json.length > 120 ? `${json.slice(0, 120)}…` : json
}

/**
 * Traduz `changes` para uma lista de alterações legíveis.
 *
 * Em `insert` e `delete` o diff é a linha inteira, e listar as 30 colunas de um
 * chamado recém-criado afogaria a trilha. Nos dois casos a função devolve lista
 * vazia e a tela escreve "criou" ou "apagou" — que é a informação toda.
 */
export function alteracoesLegiveis(changes: Record<string, unknown>): Alteracao[] {
  if (!changes || typeof changes !== 'object') return []
  if ('created' in changes || 'deleted' in changes) return []

  const out: Alteracao[] = []
  for (const [campo, valor] of Object.entries(changes)) {
    if (RUIDO.has(campo)) continue
    if (!valor || typeof valor !== 'object') continue
    const par = valor as { old?: unknown; new?: unknown }
    if (!('old' in par) && !('new' in par)) continue
    out.push({ campo, de: legivel(par.old), para: legivel(par.new) })
  }
  return out
}

/** Quantas colunas uma criação ou exclusão carregou, para a tela dizer o tamanho. */
export function tamanhoDoRegistro(changes: Record<string, unknown>): number | null {
  const corpo = (changes?.created ?? changes?.deleted) as Record<string, unknown> | undefined
  return corpo && typeof corpo === 'object' ? Object.keys(corpo).length : null
}
