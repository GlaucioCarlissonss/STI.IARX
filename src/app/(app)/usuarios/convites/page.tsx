import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { allowed, requireScreen } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { Badge, Card, EmptyState, PageHeader, Table, Td } from '@/components/ui'
import { BotaoDeRevogar, FormularioDeConvite } from './forms'

export const metadata: Metadata = { title: 'Convites' }

interface Convite {
  id: number
  email: string
  role: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
}

const PAPEL: Record<string, string> = {
  admin: 'Administrador',
  gestor: 'Gestor',
  atendente: 'Atendente',
  solicitante: 'Solicitante',
}

type Situacao = { texto: string; tom: 'ok' | 'neutral' | 'warn' | 'info' }

/**
 * A situação de cada convite, com o relógio lido UMA vez.
 *
 * Fica fora do componente pela mesma razão de `onlineUserIds` em `/usuarios`:
 * ler o relógio durante a renderização é impuro, e o mesmo render poderia
 * produzir resultados diferentes. Aqui o instante é capturado uma vez e o
 * componente só consome o mapa pronto.
 */
function situacoes(lista: Convite[]): Map<number, Situacao> {
  const agora = Date.now()
  return new Map(
    lista.map((c): [number, Situacao] => {
      if (c.accepted_at) return [c.id, { texto: 'aceito', tom: 'ok' }]
      if (c.revoked_at) return [c.id, { texto: 'revogado', tom: 'neutral' }]
      if (new Date(c.expires_at).getTime() < agora) return [c.id, { texto: 'vencido', tom: 'warn' }]
      return [c.id, { texto: 'aguardando', tom: 'info' }]
    }),
  )
}

/**
 * Os convites da empresa.
 *
 * ## O que esta tela mostra que a de usuários não mostra
 *
 * Quem foi convidado e **ainda não entrou**. É a diferença entre "mandei o
 * convite" e "a pessoa está usando" — e, sem ela, a única forma de saber era
 * perguntar à pessoa.
 *
 * O `token_hash` existe na tabela e não aparece aqui: é hash, então nem quem o
 * lesse montaria o link, mas exibi-lo não serviria para nada e daria a impressão
 * de que serve.
 */
export default async function ConvitesPage() {
  await requireScreen('usuarios.convites.ver')

  const supabase = await createClient()
  const [{ data: convites }, podeCriar, podeRevogar] = await Promise.all([
    supabase
      .from('invites')
      .select('id, email, role, expires_at, accepted_at, revoked_at, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .returns<Convite[]>(),
    allowed('usuarios.convites.criar'),
    allowed('usuarios.convites.revogar'),
  ])

  const lista = convites ?? []
  const situacao = situacoes(lista)

  return (
    <>
      <PageHeader
        title="Convites"
        description="Quem foi convidado para esta empresa, e quem ainda não entrou."
      />

      {podeCriar && (
        <Card title="Convidar alguém" className="mb-6">
          <FormularioDeConvite podeCriar={podeCriar} />
          <p className="mt-3 text-xs text-[var(--color-ink-3)]">
            A pessoa recebe um link para criar a própria senha. Ela{' '}
            <strong>não precisa confirmar o e-mail</strong>: o link já chegou nele, e isso é a
            mesma prova. Você não pode convidar para um papel acima do seu.
          </p>
        </Card>
      )}

      {lista.length === 0 ? (
        <EmptyState
          title="Nenhum convite ainda"
          description="Convide alguém pelo formulário acima. Enquanto o convite não for aceito, ele aparece aqui com o prazo."
        />
      ) : (
        <Card title="Enviados">
          <Table label="Convites" head={['Para', 'Papel', 'Situação', 'Prazo', '']}>
            {lista.map((c) => {
              const s = situacao.get(c.id)!
              const pendente = !c.accepted_at && !c.revoked_at
              return (
                <tr key={c.id}>
                  <Td className="text-[var(--color-ink-2)]">{c.email}</Td>
                  <Td className="text-[var(--color-ink-2)]">{PAPEL[c.role] ?? c.role}</Td>
                  <Td>
                    <Badge tone={s.tom}>{s.texto}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-[var(--color-ink-3)]">
                    {c.accepted_at
                      ? `aceito em ${formatDateTime(c.accepted_at)}`
                      : `vale até ${formatDateTime(c.expires_at)}`}
                  </Td>
                  <Td>
                    {/* Revogar só o que ainda pode ser usado. Convite aceito é
                        história, e revogá-lo não tiraria o acesso de ninguém —
                        para isso existe desativar a pessoa em /usuarios. */}
                    {podeRevogar && pendente ? <BotaoDeRevogar id={c.id} /> : null}
                  </Td>
                </tr>
              )
            })}
          </Table>
        </Card>
      )}
    </>
  )
}
