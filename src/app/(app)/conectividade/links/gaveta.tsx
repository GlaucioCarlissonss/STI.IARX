import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { getBranches } from '@/lib/data/lookups'
import { formatCurrency, formatDate, formatMinutes } from '@/lib/format'
import { linkStateLabel, linkStatusLabel, linkTechnologyLabel } from '@/lib/i18n'
import type { BranchArea, InternetLink, LinkAvailabilityEvent } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { Attachments, type AttachmentRecord } from '@/components/attachments'
import { EditLinkForm, LinkOutageForm, LinkStatusShortcut, NewLinkForm } from './link-forms'
import { MonitoramentoCard, type EntradaDeMonitoramento } from './monitoramento'

/**
 * O link de internet na gaveta.
 *
 * Era a tela com o painel mais pesado de todas: ficha, atalho de status,
 * disponibilidade (com o formulário de queda e o histórico de eventos) e
 * anexos, tudo dentro de uma linha da tabela — e, para alimentá-lo, a tela
 * buscava anexos e eventos de TODOS os links da página.
 *
 * Agora a lista busca apenas os dois FATOS que ela mostra por link ("tem
 * contrato anexado?" e "tem queda em aberto?"), e o resto vem aqui, do link
 * que está aberto.
 *
 * ## A entrada de monitoramento também é um modo
 *
 * Ela é configuração do tenant, não de um link: o endereço do webhook que o
 * Zabbix chama. Ficava num cartão fixo de 25rem ao lado de uma tabela de nove
 * colunas.
 */
export async function GavetaDeLink({
  id,
  novo,
  monitoramento,
  fechar,
}: {
  id?: string
  novo?: boolean
  monitoramento?: boolean
  fechar: string
}) {
  const [podeCriar, podeEditar, podeMudarStatus, podeRegistrar, podeAnexar, podeMonitorar] =
    await Promise.all([
      allowed('conectividade.links.criar'),
      allowed('conectividade.links.editar'),
      allowed('conectividade.links.mudar_status'),
      allowed('conectividade.links.registrar_evento'),
      allowed('conectividade.links.anexar'),
      allowed('conectividade.links.monitoramento'),
    ])

  const supabase = await createClient()

  if (monitoramento) {
    if (!podeMonitorar) return null
    const { data: entradas } = await supabase
      .from('monitoring_webhooks')
      .select('id, name, active, last_seen_at, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })

    return (
      <Gaveta fechar={fechar} rotulo="Entrada de monitoramento">
        <CabecalhoDaGaveta
          titulo="Entrada de monitoramento"
          linha="Webhook que o Zabbix (ou outro monitor) chama"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <MonitoramentoCard
            entradas={(entradas ?? []) as EntradaDeMonitoramento[]}
            origem={await origemDaRequisicao()}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  const [branches, { data: areas }, { data: fornecedores }] = await Promise.all([
    getBranches(),
    supabase
      .from('branch_areas')
      .select('id, branch_id, name, code, kind, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .returns<BranchArea[]>(),
    supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name'),
  ])

  if (novo) {
    if (!podeCriar) return null
    return (
      <Gaveta fechar={fechar} rotulo="Novo link">
        <CabecalhoDaGaveta titulo="Novo link" linha="Cadastro de link de internet" fechar={fechar} />
        <CorpoDaGaveta>
          <NewLinkForm
            branches={branches}
            areas={areas ?? []}
            suppliers={fornecedores ?? []}
          />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!id) return null

  const { data: link } = await supabase
    .from('internet_links')
    .select(
      'id, branch_id, branch_area_id, contract_number, supplier_id, carrier_name, technology, download_mbps, upload_mbps, guaranteed_mbps, has_static_ip, static_ip, cpe_brand, cpe_model, cpe_serial, status, monthly_cost, activated_on, cancelled_on, contract_start, contract_end, monitoring_host, last_state, last_state_at, notes',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<InternetLink>()

  if (!link) return null

  const [{ data: anexos }, { data: eventos }] = await Promise.all([
    supabase
      .from('internet_link_attachments')
      .select('id, link_id, storage_path, file_name, mime_type, size_bytes, created_at, kind')
      .eq('link_id', id)
      .order('created_at', { ascending: false })
      .returns<(AttachmentRecord & { link_id: string })[]>(),
    supabase
      .from('link_availability_events')
      .select('id, link_id, state, started_at, ended_at, duration_seconds, source, note')
      .eq('link_id', id)
      .order('started_at', { ascending: false })
      .limit(12)
      .returns<(LinkAvailabilityEvent & { link_id: string })[]>(),
  ])

  const filial = branches.find((b) => b.id === link.branch_id)
  const fornecedor = (fornecedores ?? []).find((f) => f.id === link.supplier_id)
  const quedaAberta = (eventos ?? []).some((e) => e.state === 'down' && e.ended_at === null)

  return (
    <Gaveta fechar={fechar} rotulo={link.contract_number ?? 'Link de internet'}>
      <CabecalhoDaGaveta
        titulo={link.contract_number ?? (fornecedor?.name ?? 'Link de internet')}
        linha={`${filial ? filial.name : 'sem filial'} · ${
          linkTechnologyLabel[link.technology] ?? link.technology
        } · ${link.download_mbps}/${link.upload_mbps} Mbps · ${formatCurrency(link.monthly_cost)}/mês`}
        fechar={fechar}
        selo={
          <>
            <Badge tone={link.status === 'active' ? 'ok' : 'neutral'}>
              {linkStatusLabel[link.status] ?? link.status}
            </Badge>
            <Badge
              tone={
                link.last_state === 'up'
                  ? 'ok'
                  : link.last_state === 'down'
                    ? 'breach'
                    : 'neutral'
              }
            >
              {linkStateLabel[link.last_state] ?? link.last_state}
            </Badge>
          </>
        }
      />

      <CorpoDaGaveta>
        {podeEditar && (
          <EditLinkForm
            link={link}
            branches={branches}
            areas={areas ?? []}
            suppliers={fornecedores ?? []}
          />
        )}

        {podeMudarStatus && <LinkStatusShortcut link={link} />}

        <section className="rounded-xl border border-[var(--color-border)] p-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">Disponibilidade</h3>
          {link.monitoring_host ? (
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              Host monitorado: <span className="font-mono text-xs">{link.monitoring_host}</span> ·
              último estado em {formatDate(link.last_state_at)}
            </p>
          ) : (
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              Link sem host monitorado. Informe o host na ficha para acompanhar disponibilidade —
              até então o estado é <em>não monitorado</em>, e não &ldquo;no ar&rdquo;.
            </p>
          )}

          {podeRegistrar && (
            <div className="mb-3">
              <LinkOutageForm link={link} aberta={quedaAberta} />
            </div>
          )}

          {(eventos ?? []).length > 0 ? (
            <ol className="flex flex-col gap-1.5 text-sm">
              {(eventos ?? []).slice(0, 8).map((e) => (
                <li key={e.id} className="text-[var(--color-ink-2)]">
                  <span className="font-medium text-[var(--color-ink)]">
                    {formatDate(e.started_at)}
                  </span>{' '}
                  —{' '}
                  {e.ended_at
                    ? `${formatMinutes(Math.round((e.duration_seconds ?? 0) / 60))} fora do ar`
                    : 'em aberto'}
                  {e.source !== 'manual' && ` · ${e.source}`}
                  {e.note && ` · ${e.note}`}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm italic text-[var(--color-ink-3)]">Nenhuma queda registrada.</p>
          )}
        </section>

        {(podeAnexar || (anexos ?? []).length > 0) && (
          <Attachments
            entity="links"
            entityId={link.id}
            records={anexos ?? []}
            title="Contratos e laudos"
          />
        )}
      </CorpoDaGaveta>
    </Gaveta>
  )
}

/**
 * A base da URL, vinda do cabeçalho da requisição.
 *
 * O endereço do webhook precisa ser COPIÁVEL, e um caminho relativo não serve
 * para colar num script de mídia do Zabbix. `window.location` não existe na
 * primeira pintura, e uma variável de ambiente estaria errada em qualquer
 * ambiente que não fosse o configurado — inclusive na máquina de quem
 * desenvolve.
 */
async function origemDaRequisicao(): Promise<string> {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const protocolo = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${protocolo}://${host}`
}
