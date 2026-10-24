import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import {
  compararInventarios,
  desdeQuando,
  formatarBytes,
  inventarioSchema,
} from '@/lib/agent/inventario'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { RevogarMaquina } from './revogar'

export const metadata: Metadata = { title: 'Máquina' }

interface Maquina {
  id: string
  device_uuid: string
  hostname: string | null
  os: string | null
  os_version: string | null
  chassis: string | null
  agent_version: string | null
  it_asset_id: string | null
  match_method: string | null
  divergences: Record<string, { cadastrado?: string; agente?: string }>
  last_seen_at: string | null
  last_snapshot_at: string | null
  enrollment_id: string | null
  created_at: string
  branch: { name: string } | null
  asset: { asset_tag: string | null; serial_number: string | null } | null
}

interface Snapshot {
  id: string
  payload: unknown
  collected_at: string
}

interface Programa {
  name: string
  version: string
  publisher: string | null
  first_seen_at: string
  last_seen_at: string
}

const ROTULO_DE_DIVERGENCIA: Record<string, string> = {
  serial_number: 'Número de série',
  model: 'Modelo',
}

/**
 * Uma máquina: o que ela é, o que mudou nela, e o que tem instalado.
 *
 * ## A ordem das seções não é arbitrária
 *
 * Divergências primeiro, depois mudanças, depois o retrato atual, depois o
 * software. É a ordem do que **exige decisão** para o que é só consulta: quem
 * abre esta tela normalmente veio da lista por causa de um aviso, e enterrar o
 * aviso embaixo de uma ficha técnica de quarenta linhas obrigaria a procurar o
 * motivo de ter vindo.
 *
 * ## Por que o histórico mostra a frase e não o diff
 *
 * O `jsonb` bruto de dois inventários lado a lado é ilegível para quem opera, e
 * quem opera é o público desta tela. "Memória caiu de 16 GB para 8 GB" responde a
 * pergunta inteira numa linha; um diff de 300 linhas de JSON responde a mesma
 * pergunta depois de dez minutos de leitura. O payload continua guardado para
 * quem precisar do detalhe.
 */
export default async function MaquinaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireScreen('inventario.agentes.ver')
  const podeGerenciar = await allowed('inventario.agentes.gerenciar')

  const supabase = await createClient()

  const [{ data: maquina }, { data: snapshots }, { data: programas }] = await Promise.all([
    supabase
      .from('agent_devices')
      .select(
        'id, device_uuid, hostname, os, os_version, chassis, agent_version, it_asset_id, match_method, divergences, last_seen_at, last_snapshot_at, enrollment_id, created_at, branch:branches(name), asset:it_assets(asset_tag, serial_number)',
      )
      .eq('id', id)
      .maybeSingle<Maquina>(),
    supabase
      .from('agent_inventory_snapshots')
      .select('id, payload, collected_at')
      .eq('device_id', id)
      .order('collected_at', { ascending: false })
      .limit(20)
      .returns<Snapshot[]>(),
    supabase
      .from('agent_software')
      .select('name, version, publisher, first_seen_at, last_seen_at')
      .eq('device_id', id)
      .order('name')
      .limit(500)
      .returns<Programa[]>(),
  ])

  /* RLS nega devolvendo zero linhas, não erro: máquina de outro tenant e máquina
     inexistente chegam aqui exatamente iguais, e as duas são um 404. */
  if (!maquina) notFound()

  const historico = snapshots ?? []
  const atual = historico[0]
  const inv = atual ? inventarioSchema.partial().safeParse(atual.payload) : null
  const dados = inv?.success ? inv.data : null

  const divergencias = Object.entries(maquina.divergences ?? {})

  /* O último software visto na coleta mais recente é o que está instalado; o que
     ficou para trás foi desinstalado, e é informação de segurança, não lixo. */
  const corte = maquina.last_snapshot_at
    ? new Date(maquina.last_snapshot_at).getTime() - 60_000
    : 0
  const lista = programas ?? []
  const instalados = lista.filter((p) => new Date(p.last_seen_at).getTime() >= corte)
  const sumiram = lista.filter((p) => new Date(p.last_seen_at).getTime() < corte)

  const mudancas: { quando: string; frases: string[] }[] = []
  for (let i = 0; i < historico.length - 1; i += 1) {
    const frases = compararInventarios(historico[i + 1]!.payload, historico[i]!.payload)
    if (frases.length > 0) mudancas.push({ quando: historico[i]!.collected_at, frases })
  }

  return (
    <>
      <PageHeader
        title={maquina.hostname ?? 'Máquina sem nome'}
        description={`${maquina.branch?.name ?? 'Sem filial'} · último contato ${desdeQuando(maquina.last_seen_at)}`}
        action={
          <div className="flex items-center gap-3">
            {maquina.it_asset_id && (
              <Link
                href={`/inventario?busca=${encodeURIComponent(maquina.asset?.asset_tag ?? maquina.hostname ?? '')}` as Route}
                className="text-sm font-medium text-[var(--color-brand-ink)] hover:underline"
              >
                Ver no inventário
              </Link>
            )}
            {podeGerenciar && <RevogarMaquina deviceId={maquina.id} />}
          </div>
        }
      />

      {divergencias.length > 0 && (
        <Card title="O cadastro e a máquina discordam" className="mb-6">
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            O agente <strong>não sobrescreveu</strong> o que foi digitado. Sobrescrever apagaria uma
            correção feita de propósito; ignorar deixaria o erro para sempre. Quem decide é você.
          </p>
          <Table label="Divergências" head={['Campo', 'No cadastro', 'Lido na máquina']}>
            {divergencias.map(([campo, valores]) => (
              <tr key={campo}>
                <Td>{ROTULO_DE_DIVERGENCIA[campo] ?? campo}</Td>
                <Td className="font-mono text-xs">{valores.cadastrado ?? '—'}</Td>
                <Td className="font-mono text-xs">{valores.agente ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card title="Identificação">
          <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-y-2 text-sm">
            <dt className="text-[var(--color-ink-3)]">Sistema</dt>
            <dd className="text-[var(--color-ink)]">
              {maquina.os_version ?? maquina.os ?? '—'}
              {dados?.sistema?.os_build ? ` (build ${dados.sistema.os_build})` : ''}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Fabricante e modelo</dt>
            <dd className="text-[var(--color-ink)]">
              {[dados?.sistema?.fabricante, dados?.sistema?.modelo].filter(Boolean).join(' ') || '—'}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Número de série</dt>
            <dd className="font-mono text-xs text-[var(--color-ink)]">
              {dados?.sistema?.numero_serie ?? '—'}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Domínio</dt>
            <dd className="text-[var(--color-ink)]">{dados?.sistema?.dominio ?? '—'}</dd>
            <dt className="text-[var(--color-ink-3)]">Usuário logado</dt>
            <dd className="text-[var(--color-ink)]">{dados?.sistema?.usuario_logado ?? '—'}</dd>
            <dt className="text-[var(--color-ink-3)]">Versão do agente</dt>
            <dd className="text-[var(--color-ink)]">{maquina.agent_version ?? '—'}</dd>
            <dt className="text-[var(--color-ink-3)]">Identidade</dt>
            <dd className="font-mono text-xs text-[var(--color-ink-2)]">{maquina.device_uuid}</dd>
          </dl>
        </Card>

        <Card title="Hardware">
          <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-y-2 text-sm">
            <dt className="text-[var(--color-ink-3)]">Processador</dt>
            <dd className="text-[var(--color-ink)]">
              {dados?.processador?.modelo ?? '—'}
              {dados?.processador?.nucleos ? ` · ${dados.processador.nucleos} núcleos` : ''}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Memória</dt>
            <dd className="text-[var(--color-ink)]">
              {formatarBytes(dados?.memoria?.total_bytes)}
              {dados?.memoria?.pentes?.length
                ? ` em ${dados.memoria.pentes.length} pente(s)`
                : ''}
            </dd>
            <dt className="text-[var(--color-ink-3)]">BIOS</dt>
            <dd className="text-[var(--color-ink)]">
              {dados?.bios?.versao ?? '—'}
              {dados?.bios?.modo ? ` · ${dados.bios.modo.toUpperCase()}` : ''}
            </dd>
            <dt className="text-[var(--color-ink-3)]">Ligada há</dt>
            <dd className="text-[var(--color-ink)]">
              {dados?.sistema?.tempo_ligado_s
                ? `${Math.floor(dados.sistema.tempo_ligado_s / 86400)} dia(s)`
                : '—'}
            </dd>
          </dl>

          {(dados?.discos ?? []).length > 0 && (
            <div className="mt-4">
              <Table label="Discos" head={['Modelo', 'Tamanho', 'Tipo', 'SMART']}>
                {(dados?.discos ?? []).map((d, i) => (
                  <tr key={`${d.dispositivo ?? ''}-${i}`}>
                    <Td>{d.modelo ?? d.dispositivo ?? '—'}</Td>
                    <Td className="text-[var(--color-ink-2)]">{formatarBytes(d.tamanho_bytes)}</Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {d.tipo === 'desconhecido' ? '—' : (d.tipo ?? '—').toUpperCase()}
                    </Td>
                    <Td>
                      {d.saude === 'falha' ? (
                        <Badge tone="breach">falha</Badge>
                      ) : d.saude === 'atencao' ? (
                        <Badge tone="warn">atenção</Badge>
                      ) : d.saude === 'ok' ? (
                        <Badge tone="ok">ok</Badge>
                      ) : (
                        <span className="text-[var(--color-ink-3)]">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Card>
      </div>

      <Card title="O que mudou nesta máquina" className="mb-6">
        {mudancas.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-2)]">
            Nada mudou entre as coletas guardadas. Num parque saudável esse é o normal — o agente só
            grava uma linha nova quando o inventário muda de verdade.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {mudancas.map((m) => (
              <li key={m.quando} className="border-l-2 border-[var(--color-line)] pl-3">
                <p className="text-xs text-[var(--color-ink-3)]">{formatDateTime(m.quando)}</p>
                {m.frases.map((f) => (
                  <p key={f} className="text-sm text-[var(--color-ink)]">
                    {f}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Software instalado (${instalados.length})`}>
        {instalados.length === 0 ? (
          <EmptyState
            title="Nenhum programa coletado"
            description="O agente envia a lista de programas junto do inventário. Se está vazia, pode ser que ele ainda não tenha completado a primeira coleta."
          />
        ) : (
          <Table label="Software instalado" head={['Programa', 'Versão', 'Fabricante', 'Visto em']}>
            {instalados.map((p) => (
              <tr key={`${p.name}-${p.version}`}>
                <Td>{p.name}</Td>
                <Td className="text-[var(--color-ink-2)]">{p.version || '—'}</Td>
                <Td className="text-[var(--color-ink-2)]">{p.publisher ?? '—'}</Td>
                <Td className="text-[var(--color-ink-2)]">{formatDateTime(p.last_seen_at)}</Td>
              </tr>
            ))}
          </Table>
        )}

        {sumiram.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
              Deixaram de aparecer ({sumiram.length})
            </h3>
            <p className="mb-3 text-sm text-[var(--color-ink-2)]">
              Programas que estavam na máquina e sumiram. A lista não é apagada de propósito:
              &ldquo;quem desinstalou o antivírus?&rdquo; é pergunta de segurança, e apagar a linha
              apagaria a resposta.
            </p>
            <Table label="Programas desinstalados" head={['Programa', 'Versão', 'Visto pela última vez']}>
              {sumiram.map((p) => (
                <tr key={`ex-${p.name}-${p.version}`}>
                  <Td className="text-[var(--color-ink-2)]">{p.name}</Td>
                  <Td className="text-[var(--color-ink-2)]">{p.version || '—'}</Td>
                  <Td className="text-[var(--color-ink-2)]">{formatDateTime(p.last_seen_at)}</Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>
    </>
  )
}
