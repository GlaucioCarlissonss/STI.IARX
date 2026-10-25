'use client'

import { useActionState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Badge, Card, ErrorNote, Field, Table, Td, inputClass } from '@/components/ui'
import { ROTULO_DO_CAMPO, type CampoDeTicket } from '@/lib/integrations/regras'
import { simularPayload, type ResultadoDaSimulacao } from './simulacao-actions'

/**
 * O ensaio: o que este payload produziria, sem produzir nada.
 *
 * ## Por que ela precisa existir
 *
 * O mapeamento é a peça em que o erro não dá erro. Caminho de origem digitado
 * errado, de-para incompleto, busca que o webhook desta integração não resolve
 * — nenhum dos três falha. Os três criam o chamado com o campo em branco, a
 * partir do próximo evento, e o estrago só aparece quando alguém procura o
 * chamado pelo campo que nunca foi preenchido.
 *
 * Aqui a pessoa cola um payload de verdade — copiado do log do sistema de
 * origem, ou da documentação dele — e vê o resultado antes de qualquer evento
 * chegar.
 *
 * ## O que torna o ensaio confiável
 *
 * Ele chama a mesma função que o webhook chama. Uma segunda implementação
 * "para efeito de simulação" divergiria em semanas, e a tela passaria a
 * atestar o que o sistema não faz — que é pior do que não ter tela nenhuma,
 * porque dá confiança.
 */
export function Simulacao({ integrationId }: { integrationId: string }) {
  const [resultado, formAction] = useActionState<ResultadoDaSimulacao, FormData>(
    simularPayload,
    {},
  )

  const temResultado =
    resultado.campos !== undefined ||
    resultado.erros !== undefined ||
    resultado.buscas !== undefined

  return (
    <Card title="Ensaiar um payload">
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="integration_id" value={integrationId} />
        <Field
          label="Payload do sistema de origem"
          htmlFor="payload"
          hint="Cole um JSON de verdade — do log do sistema de origem ou da documentação dele. Nada é criado: nem chamado, nem evento, nem registro de chamada."
          required
        >
          <textarea
            id="payload"
            name="payload"
            rows={8}
            required
            className={`${inputClass} font-mono text-xs`}
            placeholder={'{\n  "data": {\n    "FIELDS_AFTER": { "TITLE": "Impressora parada" }\n  }\n}'}
          />
        </Field>
        <div>
          <SubmitButton pendingLabel="Ensaiando…">Ver o que isto produziria</SubmitButton>
        </div>
      </form>

      {resultado.error && (
        <div className="mt-4">
          <ErrorNote>{resultado.error}</ErrorNote>
        </div>
      )}

      {temResultado && !resultado.error && (
        <div className="mt-5 flex flex-col gap-5">
          {resultado.campos && resultado.campos.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
                O chamado sairia assim
              </h3>
              <Table head={['Campo', 'Valor', 'Veio de']} label="Campos produzidos">
                {resultado.campos.map((c) => (
                  <tr key={c.campo}>
                    <Td className="font-medium">
                      {ROTULO_DO_CAMPO[c.campo as CampoDeTicket] ?? c.campo}
                    </Td>
                    <Td className="max-w-80 truncate">{c.valor}</Td>
                    <Td className="font-mono text-xs text-[var(--color-ink-3)]">{c.regra}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          )}

          {resultado.buscas && resultado.buscas.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
                Buscas no cadastro
              </h3>
              <Table head={['Campo', 'Procurando', 'Valor', 'Resultado']} label="Buscas">
                {resultado.buscas.map((b, i) => (
                  <tr key={`${b.campo}-${i}`}>
                    <Td className="font-medium">
                      {ROTULO_DO_CAMPO[b.campo as CampoDeTicket] ?? b.campo}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{b.procurando}</Td>
                    <Td className="font-mono text-xs">{b.valor}</Td>
                    <Td>
                      {b.naoResolvida ? (
                        <span className="text-xs text-[var(--color-warn-ink)]">
                          {b.naoResolvida}
                        </span>
                      ) : b.achou ? (
                        <Badge tone="ok">{b.achou}</Badge>
                      ) : (
                        <Badge tone="breach">não encontrado — o campo fica em branco</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </div>
          )}

          {resultado.erros && resultado.erros.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-breach-ink)]">
                O que daria erro
              </h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--color-breach-ink)]">
                {resultado.erros.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {resultado.faltando && resultado.faltando.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-warn-ink)]">
                Campos que o mapeamento promete e este payload não entregou
              </h3>
              <p className="text-sm text-[var(--color-ink-2)]">
                {resultado.faltando
                  .map((c) => ROTULO_DO_CAMPO[c as CampoDeTicket] ?? c)
                  .join(' · ')}
              </p>
              <p className="mt-1 text-xs text-[var(--color-ink-3)]">
                Eles não dariam erro: a regra é opcional e sem valor padrão. O chamado nasceria com
                esses campos em branco.
              </p>
            </div>
          )}

          {resultado.campos?.length === 0 &&
            resultado.erros?.length === 0 &&
            resultado.buscas?.length === 0 && (
              <p className="text-sm text-[var(--color-breach-ink)]">
                Este payload não produziu campo nenhum. Nenhum caminho de origem do mapeamento foi
                encontrado dentro dele — é o sintoma de caminho digitado errado, ou de o payload
                vir embrulhado num nível a mais.
              </p>
            )}
        </div>
      )}
    </Card>
  )
}
