import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getSessionContext } from '@/lib/session'

/**
 * Escopo por empresa-cliente.
 *
 * ## O que ele é, e o que ele NÃO é
 *
 * **Não é fronteira de segurança.** O isolamento entre tenants continua sendo
 * `tenant_id`, no JWT, aplicado por 162 policies de RLS (ADR-002). Se este
 * módulo tiver um defeito, a pessoa vê dados do PRÓPRIO tenant fora do foco que
 * escolheu — nunca dados de outro cliente da plataforma. Essa separação é o que
 * permite aplicá-lo na camada de dados sem criar uma segunda fronteira de
 * segurança em paralelo à que já existe, que é como se cria o caso em que uma
 * protege e a outra não.
 *
 * **É foco de trabalho.** Quem atende cinco empresas passa o dia dentro de uma,
 * e até aqui filtrava tela por tela. A escolha fica em `profiles.focused_client_id`
 * (migração 0027) e vale em todas as telas ao mesmo tempo.
 *
 * ## Como cada entidade se liga ao cliente
 *
 * Não há uma forma só, e fingir que há seria esconder dados sem perceber:
 *
 * | Forma | Função | Entidades |
 * |---|---|---|
 * | `client_id` obrigatório | `porCliente` | `branches`, `sla_contracts` |
 * | `client_id` que pode ser nulo | `porClienteOuGeral` | `tickets`, `receivables` |
 * | `branch_id` obrigatório | `porFilial` | `internet_links`, `branch_areas` |
 * | `branch_id` que pode ser nulo | `porFilialOuGeral` | `it_assets`, `telecom_lines`, `payables`, `cost_centers` |
 * | **sem relação com cliente** | — | `bank_accounts`, `suppliers`, `queues`, `profiles`, `integrations` |
 *
 * A última linha é a que mais importa: aplicar o escopo onde ele não existe
 * esvaziaria a tela inteira. Conta bancária é do tenant, não do cliente.
 *
 * ## A regra única das colunas nulas
 *
 * **O foco exclui o que é de OUTRO cliente; nunca exclui o que não é de cliente
 * nenhum.** Coluna nula significa "do tenant inteiro": uma licença comprada para
 * todo mundo, um chamado interno de infraestrutura, um título que não se aloca a
 * nenhuma unidade. Esconder esses registros sob foco faria o total da tela ficar
 * errado — e errado para menos, que é o erro que ninguém percebe — e deixaria o
 * chamado interno invisível para quem está trabalhando focado o dia todo.
 *
 * É por isso que existem quatro funções e não duas: qual usar não é escolha de
 * estilo, é a nulabilidade da coluna no banco, e a tabela acima é a resposta.
 */
export interface EscopoDeCliente {
  /** `null` = todos os clientes. É o padrão e o estado de quem nunca escolheu. */
  clientId: string | null
  /** Filiais do cliente em foco. `null` quando não há foco. */
  branchIds: string[] | null
}

export const SEM_ESCOPO: EscopoDeCliente = { clientId: null, branchIds: null }

/**
 * O escopo da sessão atual.
 *
 * `cache()` do React: a mesma requisição pode montar seis blocos de página, e
 * sem isso cada um pagaria a consulta das filiais de novo.
 */
export const escopoDeCliente = cache(async (): Promise<EscopoDeCliente> => {
  const ctx = await getSessionContext()
  const clientId = ctx?.profile.focused_client_id ?? null
  if (!clientId) return SEM_ESCOPO

  const supabase = await createClient()
  const { data } = await supabase
    .from('branches')
    .select('id')
    .eq('client_id', clientId)
    .is('deleted_at', null)

  return { clientId, branchIds: (data ?? []).map((b) => b.id) }
})

/**
 * O mínimo que um construtor de consulta precisa expor para receber o escopo.
 *
 * ## Por que há uma conversão aqui, e por que ela é segura
 *
 * O tipo do `PostgrestFilterBuilder` é condicional sobre o schema inteiro: cada
 * `eq` resolve o tipo do valor a partir do nome da coluna, do `Row` e do
 * `Schema`. Passar esse tipo por um genérico `T extends Filtravel<T>` faz o
 * compilador reavaliar a cadeia toda a cada chamada, e em telas com sete
 * consultas em `Promise.all` isso estoura em `TS2589: type instantiation is
 * excessively deep`. Já estourou, no inventário.
 *
 * A conversão corta essa recursão. Ela é segura porque os três métodos devolvem
 * `this` no próprio postgrest-js — o objeto que volta É o que entrou, com um
 * filtro a mais —, então `as T` descreve o que acontece em execução, não uma
 * esperança. O preço é que um nome de coluna errado não é mais pego aqui; é por
 * isso que cada função tem um padrão certo para sua família de tabelas e a
 * tabela do topo do arquivo diz qual usar.
 */
interface Filtravel {
  eq(coluna: string, valor: string): Filtravel
  in(coluna: string, valores: readonly string[]): Filtravel
  or(filtro: string): Filtravel
}

/** Entidades cujo `client_id` é obrigatório — `branches`, `sla_contracts`. */
export function porCliente<T>(consulta: T, escopo: EscopoDeCliente, coluna = 'client_id'): T {
  if (!escopo.clientId) return consulta
  return (consulta as Filtravel).eq(coluna, escopo.clientId) as T
}

/**
 * Entidades cujo `client_id` pode ser nulo — `tickets`, `receivables`.
 *
 * Nulo entra junto: ver "a regra única das colunas nulas" no topo do arquivo.
 */
export function porClienteOuGeral<T>(
  consulta: T,
  escopo: EscopoDeCliente,
  coluna = 'client_id',
): T {
  if (!escopo.clientId) return consulta
  return (consulta as Filtravel).or(`${coluna}.is.null,${coluna}.eq.${escopo.clientId}`) as T
}

/**
 * Entidades que chegam ao cliente pela filial, com `branch_id` obrigatório —
 * `internet_links`, `branch_areas`.
 *
 * Cliente sem filial nenhuma devolve lista vazia, e `.in(…, [])` não traz nada —
 * que é a resposta certa: não existe link de um cliente que não tem unidade.
 */
export function porFilial<T>(consulta: T, escopo: EscopoDeCliente, coluna = 'branch_id'): T {
  if (!escopo.branchIds) return consulta
  return (consulta as Filtravel).in(coluna, escopo.branchIds) as T
}

/**
 * Idem, quando `branch_id` pode ser nulo — `it_assets`, `telecom_lines`,
 * `payables`, `cost_centers`.
 *
 * Nulo entra junto: ver "a regra única das colunas nulas" no topo do arquivo.
 */
export function porFilialOuGeral<T>(
  consulta: T,
  escopo: EscopoDeCliente,
  coluna = 'branch_id',
): T {
  if (!escopo.branchIds) return consulta
  const filtro =
    escopo.branchIds.length === 0
      ? `${coluna}.is.null`
      : `${coluna}.is.null,${coluna}.in.(${escopo.branchIds.join(',')})`
  return (consulta as Filtravel).or(filtro) as T
}
