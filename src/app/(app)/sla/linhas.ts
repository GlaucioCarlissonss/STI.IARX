import type { SlaDefinitionDefaults } from './sla-definition-forms'

/**
 * A definição de SLA com os nomes já resolvidos.
 *
 * Vive fora da página porque a tabela (na tela) e a gaveta (no editor) leem a
 * mesma linha com os mesmos joins — duplicar a interface era o caminho curto
 * para elas divergirem num campo e o erro aparecer só em produção.
 */
export interface DefinitionRow extends SlaDefinitionDefaults {
  priority: { label: string; color: string } | null
  category: { name: string } | null
  contract: { name: string } | null
}

/** O `select` dos dois lugares, escrito uma vez. */
export const SELECT_DE_DEFINICAO =
  'id, contract_id, category_id, priority_id, first_response_minutes, resolution_minutes, business_hours_id, is_active, priority:ticket_priorities(label, color), category:ticket_categories(name), contract:sla_contracts(name)'
