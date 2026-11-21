import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Assinatura' }

interface Assinatura {
  tenant_id: string
  name: string
  status: 'trial' | 'active' | 'suspended' | 'cancelled'
  trial_ends_on: string | null
  em_vigencia: boolean
  dias_restantes: number | null
  plano_id: string | null
  created_at: string
}

interface Plano {
  nome: string
  resumo: string
  preco_mensal: number | null
  limite_usuarios: number | null
}

interface Evento {
  id: number
  de: string | null
  para: string
  motivo: string | null
  created_at: string
}

const SITUACAO: Record<string, { rotulo: string; tom: 'ok' | 'info' | 'warn' | 'neutral' }> = {
  active: { rotulo: 'Ativa', tom: 'ok' },
  trial: { rotulo: 'Em avaliação', tom: 'info' },
  suspended: { rotulo: 'Suspensa', tom: 'warn' },
  cancelled: { rotulo: 'Cancelada', tom: 'neutral' },
}

/**
 * A situação da assinatura desta empresa.
 *
 * ## Por que esta tela existe, e por que ela é de LEITURA
 *
 * Sem ela, uma empresa fora de vigência descobre a situação sendo recusada ao
 * tentar salvar algo — e a recusa, por mais bem escrita que seja, aparece no
 * meio de um trabalho interrompido. Esta tela é o lugar para onde a recusa
 * aponta.
 *
 * Mudar a situação NÃO é daqui. Quem vende e cobra é a operação da plataforma,
 * e a mudança passa por `app.mudar_situacao_da_empresa`, que confere o papel
 * `super_admin` por dentro. Um botão "reativar" nesta tela seria um botão que a
 * própria empresa usaria para se reativar.
 *
 * ## O histórico aparece, inclusive o que foi automático
 *
 * Saber POR QUE foi suspensa é o mínimo que se deve a quem foi. Esconder isso
 * transforma a cobrança em mistério, e o primeiro telefonema é para perguntar
 * algo que a tela poderia ter dito.
 */
export default async function AssinaturaPage() {
  const { tenant } = await requireScreen('ambiente.assinatura.ver')

  const supabase = await createClient()
  const [{ data: assinatura }, { data: eventos }] = await Promise.all([
    supabase.from('vw_assinatura').select('*').maybeSingle<Assinatura>(),
    supabase
      .from('tenant_status_events')
      .select('id, de, para, motivo, created_at')
      .order('created_at', { ascending: false })
      .limit(20)
      .returns<Evento[]>(),
  ])

  if (!assinatura) {
    return (
      <>
        <PageHeader title="Assinatura" description="A situação desta empresa no STI." />
        <EmptyState
          title="Sem assinatura registrada"
          description="Esta sessão não está vinculada a uma empresa — é o caso de quem opera a plataforma."
        />
      </>
    )
  }

  const s = SITUACAO[assinatura.status] ?? { rotulo: assinatura.status, tom: 'neutral' as const }
  const historico = eventos ?? []

  /* O plano numa segunda consulta, e não num `join` na view: o catálogo é da
     PLATAFORMA e não tem `tenant_id`, então juntá-lo à view recortada por
     empresa misturaria dois escopos de RLS numa consulta só. */
  const { data: plano } = assinatura.plano_id
    ? await supabase
        .from('planos')
        .select('nome, resumo, preco_mensal, limite_usuarios')
        .eq('id', assinatura.plano_id)
        .maybeSingle<Plano>()
    : { data: null }

  return (
    <>
      <PageHeader
        title="Assinatura"
        description={`A situação da ${tenant?.name ?? 'empresa'} no STI.`}
      />

      <Card title="Situação">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={s.tom}>{s.rotulo}</Badge>
          {assinatura.status === 'trial' && assinatura.dias_restantes !== null && (
            <span className="text-sm text-[var(--color-ink-2)]">
              {assinatura.dias_restantes > 0
                ? `Faltam ${assinatura.dias_restantes} dia(s) — a avaliação vai até ${assinatura.trial_ends_on?.split('-').reverse().join('/')}.`
                : 'A avaliação termina hoje.'}
            </span>
          )}
        </div>

        {!assinatura.em_vigencia && (
          <div
            role="status"
            className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn-ink)]"
          >
            <strong>O cadastro de coisas novas está suspenso.</strong> Abrir chamado, lançar
            título e registrar medição deixam de funcionar até a contratação.{' '}
            <strong>Nada foi apagado e nada ficou escondido</strong>: a equipe continua entrando,
            consultando e exportando tudo o que é desta empresa.
          </div>
        )}

        {plano && (
          <div className="mt-4 border-t border-[var(--color-border)] pt-4">
            <p className="text-sm text-[var(--color-ink-2)]">
              Plano <strong className="text-[var(--color-ink)]">{plano.nome}</strong>
              {plano.preco_mensal !== null && (
                <>
                  {' · '}
                  {plano.preco_mensal.toLocaleString('pt-BR', {
                    style: 'currency',
                    currency: 'BRL',
                  })}
                  /mês
                </>
              )}
              {plano.limite_usuarios !== null && <> · até {plano.limite_usuarios} usuários</>}
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-3)]">{plano.resumo}</p>
          </div>
        )}

        {assinatura.em_vigencia && assinatura.status === 'trial' && (
          <p className="mt-4 text-sm text-[var(--color-ink-2)]">
            Durante a avaliação o sistema funciona por inteiro, sem recurso bloqueado. Quando o
            prazo acabar, o que para é o cadastro de coisas novas — a consulta continua.
          </p>
        )}
      </Card>

      <Card title="Histórico" className="mt-6">
        {historico.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-3)]">
            Nenhuma mudança de situação desde que a empresa foi criada em{' '}
            {formatDateTime(assinatura.created_at)}.
          </p>
        ) : (
          <Table label="Mudanças de situação" head={['Quando', 'De', 'Para', 'Motivo']}>
            {historico.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-xs text-[var(--color-ink-3)]">
                  {formatDateTime(e.created_at)}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {e.de ? (SITUACAO[e.de]?.rotulo ?? e.de) : '—'}
                </Td>
                <Td>
                  <Badge tone={SITUACAO[e.para]?.tom ?? 'neutral'}>
                    {SITUACAO[e.para]?.rotulo ?? e.para}
                  </Badge>
                </Td>
                {/* Motivo vazio é o do gatilho sem contexto — e dizer "automático"
                    é mais honesto que deixar a célula muda, porque a pessoa
                    precisa saber que ninguém decidiu aquilo à mão. */}
                <Td className="text-[var(--color-ink-2)]">{e.motivo ?? 'automático'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}
