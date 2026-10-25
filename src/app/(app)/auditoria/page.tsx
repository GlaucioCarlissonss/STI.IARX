import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { lerPagina, paginar } from '@/lib/data/paginacao'
import { formatDateTime } from '@/lib/format'
import {
  alteracoesLegiveis,
  nomeDaEntidade,
  ROTULO_DA_ACAO,
  tamanhoDoRegistro,
  type LinhaDaTrilha,
} from '@/lib/auditoria'
import { Badge, Card, EmptyState, PageHeader, Pager, StatTile, Table, Td } from '@/components/ui'

export const metadata: Metadata = { title: 'Trilha de alterações' }

/**
 * A trilha de auditoria.
 *
 * ## Por que esta tela não existia
 *
 * `app.attach_audit()` grava em `audit_log` desde a migração 0010, e hoje são 45
 * tabelas. Nunca houve como ler o resultado: a trilha era um recurso que o
 * sistema tinha no banco e não tinha na vida de ninguém.
 *
 * A pergunta que ela responde é sempre a mesma, e sempre vem em dia ruim: **quem
 * mudou isso, e para quê?** Um contrato de SLA que estava em 4 horas e amanheceu
 * em 24, um ativo que trocou de filial, um perfil de acesso que ganhou uma
 * permissão. Sem a trilha, a resposta é "ninguém sabe".
 *
 * ## O que ela mostra, e o que deixa de fora
 *
 * Criação e exclusão aparecem como o ato ("criou", "apagou") e o tamanho do
 * registro. O diff de um insert é a linha inteira, e listar trinta colunas de um
 * chamado recém-criado afogaria a trilha justamente na alteração que interessa.
 *
 * Alteração mostra campo, de e para — descartando `tenant_id`, `updated_at` e os
 * outros campos que mudam em toda linha e não dizem nada.
 */
export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string; entidade?: string; acao?: string }>
}) {
  const params = await searchParams
  await requireScreen('auditoria.trilha.ver')
  const podeVerTrabalhos = await allowed('auditoria.trabalhos.ver')

  const supabase = await createClient()
  const pagina = lerPagina(params.pagina)

  let consulta = supabase
    .from('audit_log')
    .select('id, action, entity_type, entity_id, changes, created_at, actor:profiles(full_name)', {
      count: 'exact',
    })
  if (params.entidade) consulta = consulta.eq('entity_type', params.entidade)
  if (params.acao) consulta = consulta.eq('action', params.acao)

  const [{ data: linhas, count }, { data: universo }] = await Promise.all([
    paginar(consulta.order('id', { ascending: false }), pagina).returns<LinhaDaTrilha[]>(),
    /* Os indicadores e a lista de entidades leem o acervo inteiro, e não a
       página — mesma lição da entrega 6. Duas colunas, e um teto: a trilha não
       tem fim, e `select` sem limite nela é o tipo de consulta que trava o banco
       no dia em que o acervo cresce. */
    supabase
      .from('audit_log')
      .select('action, entity_type')
      .order('id', { ascending: false })
      .limit(5000)
      .returns<{ action: string; entity_type: string }[]>(),
  ])

  const amostra = universo ?? []
  const entidades = [...new Set(amostra.map((l) => l.entity_type))].sort((a, b) =>
    nomeDaEntidade(a).localeCompare(nomeDaEntidade(b), 'pt-BR'),
  )
  const porAcao = (a: string) => amostra.filter((l) => l.action === a).length

  const lista = linhas ?? []
  const href = (p: Record<string, string | undefined>): Route => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...params, pagina: undefined, ...p })) {
      if (v) q.set(k, v)
    }
    const s = q.toString()
    return (s ? `/auditoria?${s}` : '/auditoria') as Route
  }

  return (
    <>
      <PageHeader
        title="Trilha de alterações"
        description="Quem mudou o quê, em 45 tabelas. A trigger grava desde a primeira migração; esta tela é onde se lê."
        action={
          <div className="flex flex-wrap gap-2">
            {/* Link comum, e não botão com fetch: o navegador baixa o arquivo e o
                servidor é quem monta, com o RLS de quem pediu (LG-11). */}
            {/* `<a download>`, e não `<Link>`: `/api/exportar/...` é um Route
                Handler, e navegação do lado do cliente não baixa arquivo
                nenhum. */}
            <a
              download
              href="/api/exportar/trilha"
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
            >
              Exportar CSV
            </a>
            {podeVerTrabalhos && (
              <Link
                href={'/auditoria/trabalhos' as Route}
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
              >
                Trabalhos agendados
              </Link>
            )}
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Eventos" value={count ?? 0} hint="no seu ambiente" />
        <StatTile label="Criações" value={porAcao('insert')} hint="nos 5.000 mais recentes" />
        <StatTile label="Alterações" value={porAcao('update')} hint="nos 5.000 mais recentes" />
        {/* Exclusão é o que mais costuma gerar a pergunta que traz alguém aqui. */}
        <StatTile
          label="Exclusões"
          value={porAcao('delete')}
          hint="nos 5.000 mais recentes"
          tone={porAcao('delete') > 0 ? 'warn' : 'ok'}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar a trilha">
        {(
          [
            [undefined, 'Tudo'],
            ['insert', 'Criações'],
            ['update', 'Alterações'],
            ['delete', 'Exclusões'],
          ] as const
        ).map(([valor, rotulo]) => (
          <Link
            key={rotulo}
            href={href({ acao: valor })}
            aria-current={params.acao === valor ? 'page' : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              params.acao === valor
                ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {rotulo}
          </Link>
        ))}
      </div>

      {entidades.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por registro">
          <Link
            href={href({ entidade: undefined })}
            className={`rounded-full px-2.5 py-1 text-xs ${
              params.entidade
                ? 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
                : 'bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand-ink)]'
            }`}
          >
            todos os registros
          </Link>
          {entidades.map((e) => (
            <Link
              key={e}
              href={href({ entidade: e })}
              className={`rounded-full px-2.5 py-1 text-xs ${
                params.entidade === e
                  ? 'bg-[var(--color-brand-soft)] font-semibold text-[var(--color-brand-ink)]'
                  : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              {nomeDaEntidade(e)}
            </Link>
          ))}
        </div>
      )}

      {lista.length === 0 ? (
        <EmptyState
          title={params.acao || params.entidade ? 'Nada com esse filtro' : 'Nenhum evento ainda'}
          description={
            params.acao || params.entidade
              ? 'Volte a "Tudo" para ver a trilha completa.'
              : 'A trilha grava sozinha a partir da primeira alteração em qualquer cadastro.'
          }
        />
      ) : (
        <>
          <Table label="Trilha de alterações" head={['Quando', 'Quem', 'O quê', 'Mudou']}>
            {lista.map((l) => {
              const alteracoes = alteracoesLegiveis(l.changes)
              const colunas = tamanhoDoRegistro(l.changes)
              return (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap text-[var(--color-ink-2)]">
                    {formatDateTime(l.created_at)}
                  </Td>
                  <Td>
                    {/* Ator nulo é legítimo e frequente: trigger, trabalho
                        agendado e ingestão de canal escrevem sem sessão. Dizer
                        "sistema" é mais honesto que deixar em branco. */}
                    {l.actor?.full_name ?? (
                      <span className="text-[var(--color-ink-3)]">sistema</span>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        l.action === 'delete' ? 'warn' : l.action === 'insert' ? 'ok' : 'neutral'
                      }
                    >
                      {ROTULO_DA_ACAO[l.action] ?? l.action}
                    </Badge>
                    <p className="mt-1 text-xs text-[var(--color-ink-2)]">
                      {nomeDaEntidade(l.entity_type)}
                    </p>
                  </Td>
                  <Td>
                    {alteracoes.length > 0 ? (
                      <ul className="flex flex-col gap-0.5 text-xs">
                        {alteracoes.slice(0, 6).map((a) => (
                          <li key={a.campo} className="text-[var(--color-ink-2)]">
                            <span className="font-medium text-[var(--color-ink)]">{a.campo}</span>:{' '}
                            {a.de} → {a.para}
                          </li>
                        ))}
                        {alteracoes.length > 6 && (
                          <li className="text-[var(--color-ink-3)]">
                            e mais {alteracoes.length - 6} campo(s)
                          </li>
                        )}
                      </ul>
                    ) : (
                      <span className="text-xs text-[var(--color-ink-3)]">
                        {colunas === null
                          ? 'sem diferença registrada'
                          : `o registro inteiro (${colunas} campos)`}
                      </span>
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
            base="/auditoria"
            params={params}
          />
        </>
      )}

      <Card title="O que a trilha não guarda" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>
            <strong>Leitura não é auditada.</strong> Gravar quem abriu cada tela multiplicaria o
            volume por cem e responderia a uma pergunta que quase ninguém faz.
          </li>
          <li>
            <strong>Mensagens, métricas e sugestões de IA ficam de fora</strong> — elas são o
            próprio registro, e auditá-las gravaria uma segunda cópia de cada uma.
          </li>
          <li>
            Contadores de uso (visualizações de artigo, último contato de máquina, consumo de IA)
            também não entram: mudam a cada acesso e não são fato de negócio.
          </li>
        </ul>
      </Card>
    </>
  )
}
