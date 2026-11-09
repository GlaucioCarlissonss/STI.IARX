import { requireScreen, allowed } from '@/lib/session'
import { createClient } from '@/lib/supabase/server'
import { getBranches, getBusinessHours, getClients } from '@/lib/data/lookups'
import { formatCnpj } from '@/lib/format'
import { areaKindLabel } from '@/lib/i18n'
import type { BranchArea } from '@/lib/types'
import { Badge } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import { EditPanel } from '@/components/edit-panel'
import { EditBranchForm, EditClientForm, NewClientForm, NewBranchForm } from './forms'
import { EditAreaForm, NewAreaForm, SeedAreasForm } from './area-forms'

/**
 * Cliente e filial na gaveta — quatro modos.
 *
 * Esta tela tinha o caso mais embrulhado dos treze: um painel para editar o
 * CLIENTE dentro do cartão dele, outro painel para cada FILIAL dentro da
 * tabela de filiais (e, dentro desse, as áreas da filial), mais dois cartões
 * de cadastro numa coluna fixa de 23rem. Três níveis de coisa aberta dentro de
 * coisa aberta, e a tabela de filiais sobrando com meia tela.
 *
 * Agora: `?aberto=<cliente>`, `?filial=<id>`, `?novo=1` e `?novaFilial=1`.
 * Cada um é um endereço, e nenhum deles empurra a lista para baixo.
 *
 * As ÁREAS continuam como seção dentro da gaveta da filial, com os mesmos
 * painéis de antes — elas pertencem à filial que já está aberta, e dar
 * endereço próprio a cada área seria criar um registro que ninguém procura
 * pelo nome.
 */
export async function GavetaDeCliente({
  cliente,
  filial,
  novo,
  novaFilial,
  fechar,
}: {
  cliente?: string
  filial?: string
  novo?: boolean
  novaFilial?: boolean
  fechar: string
}) {
  await requireScreen('clientes.grupos.ver')

  const [
    podeEditarCliente,
    podeCriarCliente,
    podeVerFilial,
    podeEditarFilial,
    podeCriarFilial,
    podeVerArea,
    podeCriarArea,
    podeEditarArea,
    podeInativarArea,
  ] = await Promise.all([
    allowed('clientes.grupos.editar'),
    allowed('clientes.grupos.criar'),
    allowed('clientes.filiais.ver'),
    allowed('clientes.filiais.editar'),
    allowed('clientes.filiais.criar'),
    allowed('clientes.areas.ver'),
    allowed('clientes.areas.criar'),
    allowed('clientes.areas.editar'),
    allowed('clientes.areas.inativar'),
  ])

  const clientes = await getClients()

  if (novo) {
    if (!podeCriarCliente) return null
    return (
      <Gaveta fechar={fechar} rotulo="Novo cliente">
        <CabecalhoDaGaveta titulo="Novo cliente" linha="Grupo econômico atendido" fechar={fechar} />
        <CorpoDaGaveta>
          <NewClientForm />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (novaFilial) {
    if (!podeVerFilial || !podeCriarFilial) return null
    const expedientes = await getBusinessHours()
    return (
      <Gaveta fechar={fechar} rotulo="Nova filial">
        <CabecalhoDaGaveta
          titulo="Nova filial"
          linha="Unidade de um cliente — define visibilidade e fuso do SLA"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <NewBranchForm clients={clientes} businessHours={expedientes} />
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (filial) {
    if (!podeVerFilial) return null
    const [branches, expedientes] = await Promise.all([getBranches(), getBusinessHours()])
    const alvo = branches.find((b) => b.id === filial)
    if (!alvo) return null

    const supabase = await createClient()
    const { data: areas } = podeVerArea
      ? await supabase
          .from('branch_areas')
          .select('id, branch_id, name, code, kind, is_active, sort_order')
          .eq('branch_id', alvo.id)
          .order('sort_order')
          .returns<BranchArea[]>()
      : { data: null }

    const dono = clientes.find((c) => c.id === alvo.client_id)

    return (
      <Gaveta fechar={fechar} rotulo={alvo.name}>
        <CabecalhoDaGaveta
          titulo={alvo.name}
          linha={`${dono ? (dono.trade_name ?? dono.legal_name) : 'cliente removido'} · ${
            [alvo.city, alvo.state].filter(Boolean).join(' / ') || 'sem cidade'
          } · ${alvo.timezone}`}
          fechar={fechar}
          selo={alvo.is_active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>}
        />
        <CorpoDaGaveta>
          {podeEditarFilial && (
            <EditBranchForm branch={alvo} clients={clientes} businessHours={expedientes} />
          )}
          {podeVerArea && (
            <AreasDaFilial
              branchId={alvo.id}
              areas={areas ?? []}
              podeCriar={podeCriarArea}
              podeEditar={podeEditarArea}
              podeInativar={podeInativarArea}
            />
          )}
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!cliente || !podeEditarCliente) return null
  const alvo = clientes.find((c) => c.id === cliente)
  if (!alvo) return null

  return (
    <Gaveta fechar={fechar} rotulo={alvo.trade_name ?? alvo.legal_name}>
      <CabecalhoDaGaveta
        titulo={alvo.trade_name ?? alvo.legal_name}
        linha={`${alvo.legal_name} · ${formatCnpj(alvo.cnpj)}`}
        fechar={fechar}
        selo={
          <Badge tone={alvo.status === 'active' ? 'ok' : 'neutral'}>
            {alvo.status === 'active' ? 'Ativo' : alvo.status}
          </Badge>
        }
      />
      <CorpoDaGaveta>
        <EditClientForm client={alvo} />
      </CorpoDaGaveta>
    </Gaveta>
  )
}

/**
 * Painel de áreas de uma filial.
 *
 * Server Component: decide por permissão aqui, então o formulário de cadastro
 * nem chega ao HTML de quem não pode criar. Os controles interativos moram em
 * `area-forms.tsx`, que é cliente.
 */
function AreasDaFilial({
  branchId,
  areas,
  podeCriar,
  podeEditar,
  podeInativar,
}: {
  branchId: string
  areas: BranchArea[]
  podeCriar: boolean
  podeEditar: boolean
  podeInativar: boolean
}) {
  const ativas = areas.filter((a) => a.is_active).length

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">Áreas da filial</h3>
        <span className="text-xs text-[var(--color-ink-3)]">
          {areas.length === 0
            ? 'nenhuma área'
            : `${ativas} ativa(s) de ${areas.length}`}
        </span>
      </div>

      {areas.length === 0 ? (
        <p className="mb-3 text-sm text-[var(--color-ink-2)]">
          Sem área cadastrada, ativo, linha e link desta filial ficam sem lugar. Comece pelas
          áreas padrão e ajuste depois.
        </p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1.5">
          {areas.map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-[var(--color-ink)]">
                  {a.name}
                  {a.code && (
                    <span className="ml-2 font-mono text-xs text-[var(--color-ink-3)]">{a.code}</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={a.kind === 'assistencial' ? 'warn' : 'neutral'}>
                    {areaKindLabel[a.kind] ?? a.kind}
                  </Badge>
                  {!a.is_active && <Badge>Inativa</Badge>}
                </span>
              </div>
              {(podeEditar || podeInativar) && (
                <div className="mt-2">
                  <EditPanel label="Editar área" title={`Editar ${a.name}`}>
                    <EditAreaForm area={a} canDeactivate={podeInativar} />
                  </EditPanel>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {podeCriar && (
        <div className="flex flex-col gap-3">
          {areas.length === 0 && <SeedAreasForm branchId={branchId} />}
          <EditPanel label="Nova área" title="Nova área">
            <NewAreaForm branchId={branchId} />
          </EditPanel>
        </div>
      )}
    </section>
  )
}
