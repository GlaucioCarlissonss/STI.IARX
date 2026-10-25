import { ActionForm } from '@/components/action-form'
import { SubmitButton } from '@/components/action-form'
import { EditPanel } from '@/components/edit-panel'
import { Card, EmptyState, Field, Table, Td, inputClass } from '@/components/ui'
import {
  CAMPOS_DE_TICKET,
  DESCRICAO_DA_TRANSFORMACAO,
  ROTULO_DO_CAMPO,
  TRANSFORMACOES,
  TRANSFORMACOES_DE_BUSCA,
  escreverMapaDeValores,
  type CampoDeTicket,
} from '@/lib/integrations/regras'
import type { TransformKind } from '@/lib/integrations/mapping'
import { removerRegraDeMapeamento, salvarRegraDeMapeamento } from './mapeamento-actions'

export interface RegraNaTela {
  id: string
  source_path: string
  target_field: string
  transform: string
  value_map: Record<string, string> | null
  default_value: string | null
  is_required: boolean
}

/**
 * O editor do mapeamento de campos.
 *
 * ## Por que ele não é um JSON numa caixa de texto
 *
 * Seria metade do código. Mas o mapeamento é a peça em que **o erro não dá
 * erro**: caminho de origem digitado errado, campo de destino que não existe,
 * de-para pela metade — os três produzem a mesma coisa, um chamado com o campo
 * em branco a partir do próximo evento, sem nenhuma linha de log.
 *
 * Campo de destino como lista fechada e transformação como lista fechada
 * eliminam dois desses três erros antes de a regra ser salva. O terceiro, o
 * caminho de origem, é o que a simulação logo abaixo existe para pegar.
 *
 * ## Sem JavaScript
 *
 * `<details>` para abrir o formulário de edição na própria linha. Um modal daria
 * o mesmo resultado visual ao custo de armadilha de foco, restauração de foco e
 * `Esc` escritos à mão — três lugares onde acessibilidade quebra em silêncio.
 */
export function Mapeamento({
  integrationId,
  regras,
  podeEditar,
  ehBitrix,
}: {
  integrationId: string
  regras: RegraNaTela[]
  podeEditar: boolean
  ehBitrix: boolean
}) {
  return (
    <Card title={`Mapeamento de campos (${regras.length})`}>
      {regras.length === 0 ? (
        <EmptyState
          title="Nenhum mapeamento cadastrado"
          description="Sem nenhuma regra, todo evento recebido vira um chamado em branco — e não há erro para avisar."
        />
      ) : (
        <Table
          head={[
            'Campo de origem',
            'Campo do chamado',
            'Transformação',
            'Valores',
            podeEditar ? 'Ações' : 'Obrigatório',
          ]}
          label="Mapeamento de campos"
        >
          {regras.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-xs">{r.source_path}</Td>
              <Td className="font-medium text-[var(--color-ink)]">
                {ROTULO_DO_CAMPO[r.target_field as CampoDeTicket] ?? r.target_field}
                {r.is_required && (
                  <span className="ml-1 text-[var(--color-breach-ink)]" title="Obrigatório">
                    *
                  </span>
                )}
              </Td>
              <Td className="text-[var(--color-ink-2)]">
                {r.transform}
                {TRANSFORMACOES_DE_BUSCA.includes(r.transform as TransformKind) &&
                  !ehBitrix &&
                  r.transform !== 'user_by_email' && (
                    /* O webhook genérico só resolve busca por e-mail. As outras
                       duas não dão erro: o campo fica em branco, para sempre. */
                    <span
                      className="ml-1.5 rounded bg-[var(--color-warn-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warn-ink)]"
                      title="O webhook genérico não resolve esta busca — o campo fica em branco."
                    >
                      não resolvida
                    </span>
                  )}
              </Td>
              <Td className="font-mono text-xs text-[var(--color-ink-3)]">
                {Object.keys(r.value_map ?? {}).length > 0
                  ? Object.entries(r.value_map ?? {})
                      .map(([k, v]) => `${k}→${v}`)
                      .join(', ')
                  : (r.default_value ?? '—')}
              </Td>
              <Td>
                {podeEditar ? (
                  <div className="flex flex-col gap-2">
                    <EditPanel label="Editar" title={`Regra para ${r.target_field}`}>
                      <FormularioDaRegra
                        integrationId={integrationId}
                        regra={r}
                        ehBitrix={ehBitrix}
                      />
                    </EditPanel>
                    <ActionForm action={removerRegraDeMapeamento}>
                      <input type="hidden" name="regra_id" value={r.id} />
                      <input type="hidden" name="integration_id" value={integrationId} />
                      <SubmitButton variant="danger" pendingLabel="Removendo…">
                        Remover
                      </SubmitButton>
                    </ActionForm>
                  </div>
                ) : (
                  <span className="text-[var(--color-ink-3)]">{r.is_required ? 'sim' : 'não'}</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {podeEditar && (
        <div className="mt-4">
          <EditPanel label="Acrescentar regra" title="Nova regra de mapeamento">
            <FormularioDaRegra integrationId={integrationId} regra={null} ehBitrix={ehBitrix} />
          </EditPanel>
          <p className="mt-3 text-xs text-[var(--color-ink-3)]">
            Toda alteração grava uma versão do mapeamento inteiro — dá para voltar a qualquer uma
            delas no histórico, logo abaixo.
          </p>
        </div>
      )}
    </Card>
  )
}

function FormularioDaRegra({
  integrationId,
  regra,
  ehBitrix,
}: {
  integrationId: string
  regra: RegraNaTela | null
  ehBitrix: boolean
}) {
  return (
    <ActionForm action={salvarRegraDeMapeamento} className="flex flex-col gap-4">
      <input type="hidden" name="integration_id" value={integrationId} />
      {regra && <input type="hidden" name="regra_id" value={regra.id} />}

      <Field
        label="Campo de origem"
        htmlFor={`source_path_${regra?.id ?? 'novo'}`}
        hint="Notação por ponto, como no payload: data.FIELDS_AFTER.TITLE. Índice de lista é um número: tags.0"
        required
      >
        <input
          id={`source_path_${regra?.id ?? 'novo'}`}
          name="source_path"
          defaultValue={regra?.source_path ?? ''}
          required
          maxLength={200}
          className={`${inputClass} font-mono text-xs`}
          placeholder="data.FIELDS_AFTER.TITLE"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Campo do chamado"
          htmlFor={`target_field_${regra?.id ?? 'novo'}`}
          hint="Lista fechada: um campo inventado não daria erro, produziria chamados em branco."
          required
        >
          <select
            id={`target_field_${regra?.id ?? 'novo'}`}
            name="target_field"
            defaultValue={regra?.target_field ?? 'title'}
            className={inputClass}
          >
            {CAMPOS_DE_TICKET.map((c) => (
              <option key={c} value={c}>
                {ROTULO_DO_CAMPO[c]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Transformação"
          htmlFor={`transform_${regra?.id ?? 'novo'}`}
          hint={
            ehBitrix
              ? 'Esta integração resolve as três buscas (pessoa por e-mail, pessoa por ID e fila por grupo).'
              : 'Atenção: o webhook genérico resolve apenas a busca de pessoa por e-mail. As outras duas deixam o campo em branco.'
          }
          required
        >
          <select
            id={`transform_${regra?.id ?? 'novo'}`}
            name="transform"
            defaultValue={regra?.transform ?? 'direct'}
            className={inputClass}
          >
            {TRANSFORMACOES.map((t) => (
              <option key={t} value={t}>
                {t} — {DESCRICAO_DA_TRANSFORMACAO[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="De-para de valores"
        htmlFor={`value_map_${regra?.id ?? 'novo'}`}
        hint='Um par por linha, no formato "valor de origem = valor aqui". Só é usado pela transformação de-para.'
      >
        <textarea
          id={`value_map_${regra?.id ?? 'novo'}`}
          name="value_map"
          defaultValue={escreverMapaDeValores(regra?.value_map ?? null)}
          rows={4}
          className={`${inputClass} font-mono text-xs`}
          placeholder={'em andamento = in_progress\nconcluído = resolved'}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Valor padrão"
          htmlFor={`default_value_${regra?.id ?? 'novo'}`}
          hint="Usado quando o payload não traz o campo — e é o valor fixo da transformação 'constante'."
        >
          <input
            id={`default_value_${regra?.id ?? 'novo'}`}
            name="default_value"
            defaultValue={regra?.default_value ?? ''}
            maxLength={200}
            className={inputClass}
          />
        </Field>

        <Field
          label="Obrigatório"
          htmlFor={`is_required_${regra?.id ?? 'novo'}`}
          hint="Sem valor e sem padrão, o evento é registrado com erro em vez de criar um chamado pela metade."
        >
          <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
            <input
              id={`is_required_${regra?.id ?? 'novo'}`}
              name="is_required"
              type="checkbox"
              defaultChecked={regra?.is_required ?? false}
              className="mt-0.5"
            />
            Exigir este campo no payload
          </label>
        </Field>
      </div>

      <div>
        <SubmitButton>{regra ? 'Salvar regra' : 'Acrescentar regra'}</SubmitButton>
      </div>
    </ActionForm>
  )
}
