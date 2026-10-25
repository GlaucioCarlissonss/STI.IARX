import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { requireScreen, allowed } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { centavosEmDolar } from '@/lib/ia/regras'
import { ROTULO_DA_SUGESTAO, PRECO_POR_MILHAO, type TipoDeSugestao } from '@/lib/ia/tipos'
import { Badge, Card, PageHeader, StatTile, Table, Td } from '@/components/ui'
import { ConfigForm } from './config-form'

export const metadata: Metadata = { title: 'Sugestões de IA' }

interface Config {
  enabled: boolean
  model: string
  effort: string
  secret_ref: string | null
  sugerir_resposta: boolean
  sugerir_triagem: boolean
  redigir_artigo: boolean
  enviar_notas_internas: boolean
  limite_mensal_centavos: number
  gasto_do_mes_centavos: number
  mes_de_referencia: string
  tokens_entrada: number
  tokens_saida: number
  updated_at: string
}

interface LinhaDeUso {
  id: string
  kind: string
  status: string
  custo_centavos: number
  created_at: string
  ticket_number: number | null
  ticket_title: string | null
  requested_by_name: string | null
  acted_by_name: string | null
}

/**
 * Configuração e consumo da IA.
 *
 * ## A tela mostra o que é enviado, em palavras
 *
 * Mandar o texto de um chamado para um provedor externo é uma decisão sobre dado
 * de cliente, não um detalhe técnico. Quem liga isso precisa poder responder "o
 * que vocês mandam para fora?" sem abrir o código — e a resposta precisa estar
 * aqui, não numa página de documentação que ninguém abre.
 *
 * ## E mostra quanto já gastou
 *
 * Um recurso que gasta por clique com o consumo invisível acaba virando uma
 * fatura surpresa. O acumulado do mês fica na frente da tela, ao lado do teto.
 */
export default async function IAPage() {
  await requireScreen('ia.config.ver')
  const podeGerenciar = await allowed('ia.config.gerenciar')

  const supabase = await createClient()
  const [{ data: config }, { data: uso }] = await Promise.all([
    supabase
      .from('ai_settings')
      .select(
        'enabled, model, effort, secret_ref, sugerir_resposta, sugerir_triagem, redigir_artigo, enviar_notas_internas, limite_mensal_centavos, gasto_do_mes_centavos, mes_de_referencia, tokens_entrada, tokens_saida, updated_at',
      )
      .maybeSingle<Config>(),
    supabase
      .from('vw_ai_suggestions')
      .select(
        'id, kind, status, custo_centavos, created_at, ticket_number, ticket_title, requested_by_name, acted_by_name',
      )
      .order('created_at', { ascending: false })
      .limit(50)
      .returns<LinhaDeUso[]>(),
  ])

  const linhas = uso ?? []
  const aceitas = linhas.filter((l) => l.status === 'aceita').length
  const recusadas = linhas.filter((l) => l.status === 'recusada').length
  const decididas = aceitas + recusadas

  /* Mês velho conta como zero, igual a `ai_config_utilizavel()`: no dia 1º o
     acumulado ainda é o de dezembro até a primeira chamada virar o contador. */
  const mesAtual = new Date().toISOString().slice(0, 7)
  const gasto =
    config && config.mes_de_referencia.slice(0, 7) === mesAtual ? config.gasto_do_mes_centavos : 0

  return (
    <>
      <PageHeader
        title="Sugestões de IA"
        description="Resposta, classificação e artigo — sugeridos, nunca aplicados. A chave mora no ambiente, nunca aqui."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Situação"
          value={config?.enabled ? 'ligada' : 'desligada'}
          tone={config?.enabled ? 'ok' : 'neutral'}
          hint={config?.enabled ? config.model : 'nada é enviado a provedor nenhum'}
        />
        <StatTile
          label="Gasto no mês"
          value={centavosEmDolar(gasto)}
          hint={`teto de ${centavosEmDolar(config?.limite_mensal_centavos ?? 0)}`}
          tone={
            config && gasto >= config.limite_mensal_centavos
              ? 'breach'
              : config && gasto > config.limite_mensal_centavos * 0.8
                ? 'warn'
                : 'ok'
          }
        />
        <StatTile label="Sugestões pedidas" value={linhas.length} hint="as 50 mais recentes" />
        {/* A taxa de aceitação é a única medida honesta de se a IA ajuda. Por isso
            a recusa fica registrada: apagá-la deixaria só o que deu certo. */}
        <StatTile
          label="Aceitas"
          value={decididas > 0 ? `${Math.round((aceitas / decididas) * 100)}%` : '—'}
          hint={decididas > 0 ? `${aceitas} de ${decididas} decididas` : 'nenhuma decidida ainda'}
          tone="neutral"
        />
      </div>

      <ConfigForm
        config={
          config
            ? {
                enabled: config.enabled,
                model: config.model,
                effort: config.effort,
                secret_ref: config.secret_ref,
                sugerir_resposta: config.sugerir_resposta,
                sugerir_triagem: config.sugerir_triagem,
                redigir_artigo: config.redigir_artigo,
                enviar_notas_internas: config.enviar_notas_internas,
                limite_mensal_dolares: Math.round(config.limite_mensal_centavos / 100),
              }
            : null
        }
        podeGerenciar={podeGerenciar}
        modelos={Object.keys(PRECO_POR_MILHAO)}
      />

      <Card title="O que é enviado ao provedor" className="mt-6">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-[var(--color-ink-2)]">
          <li>O título, a descrição e a situação do chamado.</li>
          <li>A categoria, a prioridade e o nome da empresa-cliente.</li>
          <li>Os comentários públicos (os 20 mais recentes).</li>
          <li>
            <strong>
              {config?.enviar_notas_internas
                ? 'As notas internas TAMBÉM são enviadas — está ligado acima.'
                : 'As notas internas NÃO são enviadas.'}
            </strong>
          </li>
          <li>Na sugestão de resposta, o título e o resumo dos artigos da base relacionados.</li>
        </ul>
        <p className="mt-3 text-sm text-[var(--color-ink-2)]">
          Nada é enviado sem alguém clicar. Não há trabalho agendado que resuma a fila de madrugada —
          isso gastaria dinheiro em chamado que ninguém abriu.
        </p>
      </Card>

      {linhas.length > 0 && (
        <Card title="Consumo recente" className="mt-6">
          <Table label="Sugestões pedidas" head={['Chamado', 'Tipo', 'Quem', 'Custo', 'Estado']}>
            {linhas.map((l) => (
              <tr key={l.id}>
                <Td>
                  {l.ticket_number ? `#${l.ticket_number}` : '—'}
                  <p className="text-xs text-[var(--color-ink-3)]">{l.ticket_title}</p>
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {ROTULO_DA_SUGESTAO[l.kind as TipoDeSugestao] ?? l.kind}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {l.requested_by_name ?? '—'}
                  {l.acted_by_name && l.acted_by_name !== l.requested_by_name && (
                    <p className="text-xs text-[var(--color-ink-3)]">
                      decidida por {l.acted_by_name}
                    </p>
                  )}
                </Td>
                <Td className="tabular-nums text-[var(--color-ink-2)]">
                  {centavosEmDolar(l.custo_centavos)}
                </Td>
                <Td>
                  <Badge
                    tone={
                      l.status === 'aceita' ? 'ok' : l.status === 'recusada' ? 'warn' : 'neutral'
                    }
                  >
                    {l.status}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
          {config && (
            <p className="mt-2 text-xs text-[var(--color-ink-3)]">
              Acumulado desde sempre: {config.tokens_entrada.toLocaleString('pt-BR')} tokens de
              entrada e {config.tokens_saida.toLocaleString('pt-BR')} de saída. Última alteração da
              configuração em {formatDateTime(config.updated_at)}.
            </p>
          )}
        </Card>
      )}
    </>
  )
}
