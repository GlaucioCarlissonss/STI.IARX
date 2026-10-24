import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { escopoDeCliente, porFilialOuGeral } from '@/lib/data/escopo'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { desdeQuando } from '@/lib/agent/inventario'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'
import { InscricaoForm } from './inscricao-form'

export const metadata: Metadata = { title: 'Agentes nas máquinas' }

interface LinhaDaFrota {
  device_id: string
  hostname: string | null
  os: string | null
  os_version: string | null
  chassis: string | null
  agent_version: string | null
  it_asset_id: string | null
  match_method: string | null
  last_seen_at: string | null
  last_snapshot_at: string | null
  asset_tag: string | null
  serial_number: string | null
  brand: string | null
  model: string | null
  branch_name: string | null
  silencioso: boolean
  tem_divergencia: boolean
  software_count: number
}

interface TokenDeInscricao {
  id: string
  name: string
  max_uses: number | null
  uses_count: number
  expires_at: string | null
  branch: { name: string } | null
}

const ROTULO_DE_SISTEMA: Record<string, string> = {
  windows: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
}

/**
 * Como a máquina foi casada com o ativo, dito para quem opera.
 *
 * A palavra importa: "hostname" é a única das quatro que merece um segundo olhar
 * (nome de máquina se repete entre equipamentos trocados), e a tela precisa dizer
 * isso sem exigir que a pessoa conheça a ordem das tentativas da conciliação.
 */
function conciliacao(metodo: string | null): { texto: string; tom: 'ok' | 'warn' | 'neutral' } {
  switch (metodo) {
    case 'serial':
      return { texto: 'Número de série', tom: 'ok' }
    case 'device_uuid':
      return { texto: 'Identidade da máquina', tom: 'ok' }
    case 'hostname':
      return { texto: 'Nome da máquina', tom: 'warn' }
    case 'created':
      return { texto: 'Ativo criado pelo agente', tom: 'neutral' }
    default:
      return { texto: 'Aguardando inventário', tom: 'neutral' }
  }
}

/**
 * A frota com agente.
 *
 * ## Por que esta tela existe separada de `/inventario`
 *
 * As duas respondem perguntas diferentes. `/inventario` é o **patrimônio**: o que
 * a empresa comprou, quanto custou, quando vence a garantia — e inclui monitor,
 * impressora e licença, que nunca vão ter agente. Esta é o **parque em operação**:
 * o que está ligado e falando agora.
 *
 * Juntar as duas numa tela só pareceria economia e produziria uma lista em que
 * metade das colunas está vazia em metade das linhas.
 *
 * ## Os quatro indicadores, e por que o segundo é o que importa
 *
 * "Máquinas mudas" é o número que justifica a tela. Agente que parou de falar é
 * invisível por natureza: não dá erro, não gera chamado, não aparece em lugar
 * nenhum — simplesmente deixa de haver dado novo, e o inventário envelhece sem
 * avisar. Quem percebe primeiro é quem for procurar um equipamento e não achar.
 */
export default async function AgentesPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string; filtro?: string }>
}) {
  const params = await searchParams
  await requireScreen('inventario.agentes.ver')
  const podeGerenciar = await allowed('inventario.agentes.gerenciar')

  const supabase = await createClient()
  const escopo = await escopoDeCliente()
  const pagina = lerPagina(params.pagina)
  const filtro = params.filtro === 'mudas' || params.filtro === 'divergentes' ? params.filtro : null

  let consulta = supabase
    .from('vw_agent_fleet')
    .select(
      'device_id, hostname, os, os_version, chassis, agent_version, it_asset_id, match_method, last_seen_at, last_snapshot_at, asset_tag, serial_number, brand, model, branch_name, silencioso, tem_divergencia, software_count',
      { count: 'exact' },
    )
  if (filtro === 'mudas') consulta = consulta.eq('silencioso', true)
  if (filtro === 'divergentes') consulta = consulta.eq('tem_divergencia', true)

  const [{ data: linhas, count }, { data: universo }, { data: tokens }, { data: filiais }] =
    await Promise.all([
    paginar(
      porFilialOuGeral(consulta.order('last_seen_at', { ascending: false, nullsFirst: false }), escopo),
      pagina,
    ).returns<LinhaDaFrota[]>(),
    /* Os indicadores leem o acervo inteiro, não a página. É a lição da entrega 6:
       indicador calculado sobre a página diria "50 máquinas" para uma frota de
       412, e o número ao lado da lista discordando da lista é o defeito que
       ninguém reporta e todo mundo nota. */
    porFilialOuGeral(
      supabase.from('vw_agent_fleet').select('silencioso, tem_divergencia, match_method'),
      escopo,
    ).returns<{ silencioso: boolean; tem_divergencia: boolean; match_method: string | null }[]>(),
    podeGerenciar
      ? supabase
          .from('agent_enrollments')
          .select('id, name, max_uses, uses_count, expires_at, branch:branches(name)')
          .is('revoked_at', null)
          .order('created_at', { ascending: false })
          .returns<TokenDeInscricao[]>()
      : Promise.resolve({ data: [] as TokenDeInscricao[] }),
    supabase
      .from('branches')
      .select('id, name')
      .is('deleted_at', null)
      .order('name')
      .returns<{ id: string; name: string }[]>(),
  ])

  const todas = universo ?? []
  const mudas = todas.filter((d) => d.silencioso).length
  const divergentes = todas.filter((d) => d.tem_divergencia).length
  const porHostname = todas.filter((d) => d.match_method === 'hostname').length

  const lista = linhas ?? []

  const filtroHref = (valor: 'mudas' | 'divergentes' | null): Route =>
    (valor ? `/inventario/agentes?filtro=${valor}` : '/inventario/agentes') as Route

  return (
    <>
      <PageHeader
        title="Agentes nas máquinas"
        description="O parque que está ligado e reportando. O inventário destas máquinas não é digitado."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Máquinas com agente" value={todas.length} />
        <StatTile
          label="Máquinas mudas"
          value={mudas}
          hint="sem contato há mais de 24 h"
          tone={mudas > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="Divergências"
          value={divergentes}
          hint="cadastro e máquina discordam"
          tone={divergentes > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="Casadas pelo nome"
          value={porHostname}
          hint="vale conferir o equipamento"
          tone={porHostname > 0 ? 'neutral' : 'ok'}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar a frota">
        {(
          [
            [null, 'Todas'],
            ['mudas', 'Só as mudas'],
            ['divergentes', 'Só as divergentes'],
          ] as const
        ).map(([valor, rotulo]) => (
          <Link
            key={rotulo}
            href={filtroHref(valor)}
            aria-current={filtro === valor ? 'page' : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              filtro === valor
                ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                : 'border-[var(--color-line)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {rotulo}
          </Link>
        ))}
      </div>

      {lista.length === 0 ? (
        <EmptyState
          title={
            filtro === 'mudas'
              ? 'Nenhuma máquina muda'
              : filtro === 'divergentes'
                ? 'Nenhuma divergência'
                : 'Nenhuma máquina com agente ainda'
          }
          description={
            filtro
              ? 'Esse é o estado bom. Volte a "Todas" para ver a frota inteira.'
              : 'Emita um token de inscrição abaixo e instale o agente. A primeira máquina aparece aqui minutos depois.'
          }
        />
      ) : (
        <>
          <Table
            label="Máquinas com agente"
            head={['Máquina', 'Sistema', 'Equipamento', 'Conciliação', 'Último contato']}
          >
            {lista.map((d) => {
              const c = conciliacao(d.match_method)
              return (
                <tr key={d.device_id}>
                  <Td>
                    <Link
                      href={`/inventario/agentes/${d.device_id}` as Route}
                      className="font-medium text-[var(--color-brand-ink)] hover:underline"
                    >
                      {d.hostname ?? 'sem nome'}
                    </Link>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {d.branch_name ?? 'sem filial'} · {d.software_count} programa(s)
                    </p>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {ROTULO_DE_SISTEMA[d.os ?? ''] ?? d.os ?? '—'}
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {d.os_version ?? ''}
                      {d.agent_version ? ` · agente ${d.agent_version}` : ''}
                    </p>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {[d.brand, d.model].filter(Boolean).join(' ') || '—'}
                    <p className="text-xs text-[var(--color-ink-3)]">
                      {d.asset_tag ?? d.serial_number ?? ''}
                    </p>
                  </Td>
                  <Td>
                    <Badge tone={c.tom}>{c.texto}</Badge>
                    {d.tem_divergencia && (
                      <p className="mt-1 text-xs text-[var(--color-warn-ink)]">
                        cadastro e máquina discordam
                      </p>
                    )}
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {d.silencioso ? (
                      <Badge tone="warn">muda {desdeQuando(d.last_seen_at)}</Badge>
                    ) : (
                      desdeQuando(d.last_seen_at)
                    )}
                  </Td>
                </tr>
              )
            })}
          </Table>
          <Pager
            pagina={pagina.numero}
            total={count ?? 0}
            tamanho={pagina.tamanho}
            base="/inventario/agentes"
            params={params}
          />
        </>
      )}

      {podeGerenciar && (
        <InscricaoForm tokens={tokens ?? []} branches={filiais ?? []} className="mt-6" />
      )}

      <Card title="O que o agente faz, e o que ele não faz" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            Coleta inventário uma vez por dia e <strong>só grava quando algo muda</strong>. Num
            parque estável, quase todo envio é apenas um sinal de vida.
          </li>
          <li>
            <strong>Nunca duplica um ativo</strong> que já foi cadastrado à mão: ele casa por número
            de série, depois pela identidade da máquina, depois pelo nome — e só cria quando nada
            casa.
          </li>
          <li>
            <strong>Não sobrescreve o que você digitou.</strong> Se o cadastro e a máquina
            discordarem, a divergência aparece na linha, e quem decide é você.
          </li>
          <li>
            Não coleta conteúdo de arquivo, navegação nem tela. O que ele lê é hardware, sistema e
            lista de programas instalados.
          </li>
        </ul>
      </Card>
    </>
  )
}
