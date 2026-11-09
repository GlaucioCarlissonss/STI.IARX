import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getAgents, getBranches } from '@/lib/data/lookups'
import { formatCurrency, formatDate } from '@/lib/format'
import { lineStatusLabel, lineTypeLabel } from '@/lib/i18n'
import type { BranchArea, TelecomLine } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { EditLineForm, NewLineForm } from './line-forms'

/**
 * A linha telefônica na gaveta.
 *
 * Mesmo caso do inventário: a ficha e os anexos moravam num painel por LINHA
 * dentro da tabela, e a tela buscava os anexos de todas as linhas da página
 * para alimentá-los. Agora a consulta de anexo acontece uma vez, para a linha
 * que está aberta.
 *
 * O cadastro, que ficava num cartão de 23rem à direita, vira botão — numa tela
 * cuja tabela tem oito colunas e ainda mostra um painel de custo por operadora
 * embaixo, essa largura fazia falta.
 */
export async function GavetaDeLinha({
  id,
  novo,
  fechar,
}: {
  id?: string
  novo?: boolean
  fechar: string
}) {
  const [podeEditar, podeCriar, podeAnexar, branches, agents] = await Promise.all([
    allowed('telefonia.linhas.editar'),
    allowed('telefonia.linhas.criar'),
    allowed('telefonia.linhas.anexar'),
    getBranches(),
    getAgents(),
  ])

  const supabase = await createClient()
  const [{ data: areas }, { data: devices }] = await Promise.all([
    supabase
      .from('branch_areas')
      .select('id, branch_id, name, code, kind, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .returns<BranchArea[]>(),
    supabase
      .from('it_assets')
      .select('id, asset_tag, brand, model')
      .is('deleted_at', null)
      .order('asset_tag', { nullsFirst: false }),
  ])

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Nova linha">
        <CabecalhoDaGaveta titulo="Nova linha" linha="Cadastro de linha telefônica" fechar={fechar} />
        <CorpoDaGaveta>
          <NewLineForm
            branches={branches}
            areas={areas ?? []}
            agents={agents}
            devices={devices ?? []}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: linha } = await supabase
    .from('telecom_lines')
    .select(
      'id, phone_number, carrier, plan_name, line_type, status, branch_id, branch_area_id, assigned_user_id, device_asset_id, monthly_cost, franchise_data_gb, contract_start, loyalty_until, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<TelecomLine>()

  if (!linha) return null

  const { data: anexos } = await supabase
    .from('telecom_line_attachments')
    .select('id, line_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
    .eq('line_id', id)
    .order('created_at', { ascending: false })
    .returns<(AttachmentRecord & { line_id: string })[]>()

  const filial = branches.find((b) => b.id === linha.branch_id)

  return (
    <Gaveta fechar={fechar} rotulo={linha.phone_number}>
      <CabecalhoDaGaveta
        titulo={linha.phone_number}
        linha={`${linha.carrier}${linha.plan_name ? ` · ${linha.plan_name}` : ''} · ${
          lineTypeLabel[linha.line_type] ?? linha.line_type
        } · ${formatCurrency(linha.monthly_cost)}/mês${
          filial ? ` · ${filial.name}` : ''
        }${linha.loyalty_until ? ` · fidelidade até ${formatDate(linha.loyalty_until)}` : ''}`}
        fechar={fechar}
        selo={
          <Badge tone={linha.status === 'active' ? 'ok' : 'neutral'}>
            {lineStatusLabel[linha.status] ?? linha.status}
          </Badge>
        }
      />
      <CorpoDaGaveta>
        {podeEditar && (
          <EditLineForm
            line={linha}
            branches={branches}
            areas={areas ?? []}
            agents={agents}
            devices={devices ?? []}
          />
        )}
        {(podeAnexar || (anexos ?? []).length > 0) && (
          <Attachments
            entity="linhas"
            entityId={linha.id}
            records={anexos ?? []}
            title="Contratos e termos"
          />
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}
