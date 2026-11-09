import { createClient } from '@/lib/supabase/server'
import { allowed } from '@/lib/session'
import { formatDateTime } from '@/lib/format'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Badge, Field, inputClass } from '@/components/ui'
import { Gaveta, CabecalhoDaGaveta, CorpoDaGaveta } from '@/components/gaveta'
import {
  CAMPOS_DE_TICKET,
  DESCRICAO_DA_TRANSFORMACAO,
  ROTULO_DO_CAMPO,
  TRANSFORMACOES,
  escreverMapaDeValores,
  type CampoDeTicket,
} from '@/lib/integrations/regras'
import {
  removerRegraDeMapeamento,
  restaurarMapeamento,
  salvarRegraDeMapeamento,
} from './mapeamento-actions'
import type { RegraNaTela } from './mapeamento'

/**
 * A gaveta da integração — a regra de mapeamento e a versão do histórico.
 *
 * ## O que ela desfaz
 *
 * O editor da regra abria num `<details>` DENTRO DA CÉLULA da última coluna da
 * tabela de mapeamento. São nove campos — caminho de origem, campo de destino,
 * transformação, de-para, valor padrão e obrigatório — espremidos na largura de
 * uma coluna chamada "Ações". Numa tela de notebook a caixa do de-para ficava
 * com quatro centímetros de largura para um conteúdo que é uma lista de pares.
 *
 * ## Por que a remoção mudou de lugar
 *
 * O botão "Remover" ficava na mesma célula, embaixo de "Editar" — dois cliques
 * de distância um do outro, um deles irreversível e o outro não. Agora ele mora
 * no fim da gaveta da regra: para remover é preciso abrir a regra, e ao abrir
 * se vê exatamente o que vai embora.
 *
 * ## Por que a versão virou gaveta também
 *
 * Porque restaurar sem ver o que se restaura é apostar. O histórico mostrava
 * número, autor e a CONTAGEM de regras; a gaveta mostra as regras daquela
 * versão, uma a uma, antes do botão que troca o mapeamento inteiro por elas.
 */
export async function GavetaDaIntegracao({
  integrationId,
  regra,
  versao,
  ehBitrix,
  fechar,
}: {
  integrationId: string
  /** Id da regra, ou `nova` para o cadastro em branco. */
  regra?: string
  /** Número da versão do histórico. */
  versao?: string
  ehBitrix: boolean
  fechar: string
}) {
  const podeMapear = await allowed('integracoes.hub.mapear')
  if (!podeMapear) return null

  const supabase = await createClient()

  if (regra === 'nova') {
    return (
      <Gaveta fechar={fechar} rotulo="Nova regra de mapeamento">
        <CabecalhoDaGaveta
          titulo="Nova regra"
          linha="Campo do payload → campo do chamado"
          fechar={fechar}
        />
        <CorpoDaGaveta>
          <FormularioDaRegra
            integrationId={integrationId}
            regra={null}
            ehBitrix={ehBitrix}
          />
          <p className="text-xs text-[var(--color-ink-3)]">
            Toda alteração grava uma versão do mapeamento inteiro — dá para voltar a qualquer uma
            delas no histórico.
          </p>
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (regra) {
    const { data: atual } = await supabase
      .from('integration_mappings')
      .select('id, source_path, target_field, transform, value_map, default_value, is_required')
      .eq('id', regra)
      .eq('integration_id', integrationId)
      .maybeSingle<RegraNaTela>()

    if (!atual) return null

    return (
      <Gaveta fechar={fechar} rotulo={`Regra para ${atual.target_field}`}>
        <CabecalhoDaGaveta
          titulo={ROTULO_DO_CAMPO[atual.target_field as CampoDeTicket] ?? atual.target_field}
          linha={atual.source_path}
          fechar={fechar}
          selo={
            atual.is_required ? <Badge tone="warn">Obrigatório</Badge> : <Badge>Opcional</Badge>
          }
        />
        <CorpoDaGaveta>
          <FormularioDaRegra
            integrationId={integrationId}
            regra={atual}
            ehBitrix={ehBitrix}
          />

          <section className="border-t border-[var(--color-border)] pt-4">
            <p className="mb-2 text-xs text-[var(--color-ink-3)]">
              Remover a regra faz o campo parar de ser preenchido a partir do próximo evento. O
              mapeamento anterior fica no histórico.
            </p>
            <ActionForm action={removerRegraDeMapeamento}>
              <input type="hidden" name="regra_id" value={atual.id} />
              <input type="hidden" name="integration_id" value={integrationId} />
              <SubmitButton variant="danger" pendingLabel="Removendo…">
                Remover esta regra
              </SubmitButton>
            </ActionForm>
          </section>
        </CorpoDaGaveta>
      </Gaveta>
    )
  }

  if (!versao) return null

  const numero = Number(versao)
  if (!Number.isInteger(numero) || numero < 1) return null

  const { data: v } = await supabase
    .from('integration_mapping_versions')
    .select('id, version, note, created_at, snapshot, profiles:created_by (full_name)')
    .eq('integration_id', integrationId)
    .eq('version', numero)
    .maybeSingle<{
      id: string
      version: number
      note: string | null
      created_at: string
      snapshot: unknown[]
      profiles: { full_name: string } | null
    }>()

  if (!v) return null

  /* O snapshot é `to_jsonb(m) - 'id' - 'created_at' - 'updated_at'`: tem os
     campos da regra, sem os de controle. Lemos defensivamente porque ele também
     é gravado por edição via SQL direto, onde ninguém garante o formato. */
  const regras = (Array.isArray(v.snapshot) ? v.snapshot : []).map((linha) => {
    const r = (linha ?? {}) as Record<string, unknown>
    return {
      source_path: typeof r.source_path === 'string' ? r.source_path : '—',
      target_field: typeof r.target_field === 'string' ? r.target_field : '—',
      transform: typeof r.transform === 'string' ? r.transform : 'direct',
      is_required: r.is_required === true,
    }
  })

  const { count: atuais } = await supabase
    .from('integration_mappings')
    .select('id', { count: 'exact', head: true })
    .eq('integration_id', integrationId)

  return (
    <Gaveta fechar={fechar} rotulo={`Versão ${v.version} do mapeamento`}>
      <CabecalhoDaGaveta
        titulo={`Versão #${v.version}`}
        linha={`${formatDateTime(v.created_at)} · ${v.profiles?.full_name ?? 'por SQL direto'}`}
        fechar={fechar}
        selo={<Badge>{regras.length} regra(s)</Badge>}
      />
      <CorpoDaGaveta>
        {regras.length === 0 ? (
          <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
            Esta versão não tem nenhuma regra. Restaurá-la deixa a integração sem mapeamento — todo
            evento recebido vira um chamado em branco.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {regras.map((r, i) => (
              <li
                key={`${r.source_path}-${i}`}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2"
              >
                <p className="font-mono text-xs text-[var(--color-ink-3)]">{r.source_path}</p>
                <p className="text-sm text-[var(--color-ink)]">
                  → {ROTULO_DO_CAMPO[r.target_field as CampoDeTicket] ?? r.target_field}
                  <span className="ml-1.5 text-xs text-[var(--color-ink-3)]">
                    {r.transform}
                    {r.is_required ? ' · obrigatório' : ''}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}

        <section className="border-t border-[var(--color-border)] pt-4">
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">
            O mapeamento atual ({atuais ?? 0} regra(s)) é <strong>trocado inteiro</strong> pelas{' '}
            {regras.length} desta versão, em uma transação — não há instante com o mapeamento
            vazio. A troca também vira uma versão nova, então dá para voltar atrás da volta.
          </p>
          <ActionForm action={restaurarMapeamento}>
            <input type="hidden" name="integration_id" value={integrationId} />
            <input type="hidden" name="version" value={v.version} />
            <SubmitButton variant="danger" pendingLabel="Restaurando…">
              Restaurar a versão #{v.version}
            </SubmitButton>
          </ActionForm>
        </section>
      </CorpoDaGaveta>
    </Gaveta>
  )
}

/**
 * O formulário da regra.
 *
 * Campo de destino e transformação são listas fechadas porque o mapeamento é a
 * peça em que **o erro não dá erro**: caminho digitado errado, campo que não
 * existe ou de-para pela metade produzem a mesma coisa — chamado com o campo em
 * branco a partir do próximo evento, sem nenhuma linha de log. Duas das três
 * causas somem com lista fechada; a terceira é o que a simulação pega.
 */
function FormularioDaRegra({
  integrationId,
  regra,
  ehBitrix,
}: {
  integrationId: string
  regra: RegraNaTela | null
  ehBitrix: boolean
}) {
  const uid = regra?.id ?? 'novo'
  return (
    <ActionForm action={salvarRegraDeMapeamento} className="flex flex-col gap-4">
      <input type="hidden" name="integration_id" value={integrationId} />
      {regra && <input type="hidden" name="regra_id" value={regra.id} />}

      <Field
        label="Campo de origem"
        htmlFor={`source_path_${uid}`}
        hint="Notação por ponto, como no payload: data.FIELDS_AFTER.TITLE. Índice de lista é um número: tags.0"
        required
      >
        <input
          id={`source_path_${uid}`}
          name="source_path"
          defaultValue={regra?.source_path ?? ''}
          required
          maxLength={200}
          className={`${inputClass} font-mono text-xs`}
          placeholder="data.FIELDS_AFTER.TITLE"
        />
      </Field>

      <Field
        label="Campo do chamado"
        htmlFor={`target_field_${uid}`}
        hint="Lista fechada: um campo inventado não daria erro, produziria chamados em branco."
        required
      >
        <select
          id={`target_field_${uid}`}
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
        htmlFor={`transform_${uid}`}
        hint={
          ehBitrix
            ? 'Esta integração resolve as três buscas (pessoa por e-mail, pessoa por ID e fila por grupo).'
            : 'Atenção: o webhook genérico resolve apenas a busca de pessoa por e-mail. As outras duas deixam o campo em branco.'
        }
        required
      >
        <select
          id={`transform_${uid}`}
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

      <Field
        label="De-para de valores"
        htmlFor={`value_map_${uid}`}
        hint='Um par por linha, no formato "valor de origem = valor aqui". Só é usado pela transformação de-para.'
      >
        <textarea
          id={`value_map_${uid}`}
          name="value_map"
          defaultValue={escreverMapaDeValores(regra?.value_map ?? null)}
          rows={4}
          className={`${inputClass} font-mono text-xs`}
          placeholder={'em andamento = in_progress\nconcluído = resolved'}
        />
      </Field>

      <Field
        label="Valor padrão"
        htmlFor={`default_value_${uid}`}
        hint="Usado quando o payload não traz o campo — e é o valor fixo da transformação 'constante'."
      >
        <input
          id={`default_value_${uid}`}
          name="default_value"
          defaultValue={regra?.default_value ?? ''}
          maxLength={200}
          className={inputClass}
        />
      </Field>

      <Field
        label="Obrigatório"
        htmlFor={`is_required_${uid}`}
        hint="Sem valor e sem padrão, o evento é registrado com erro em vez de criar um chamado pela metade."
      >
        <label className="flex items-start gap-2.5 text-sm text-[var(--color-ink)]">
          <input
            id={`is_required_${uid}`}
            name="is_required"
            type="checkbox"
            defaultChecked={regra?.is_required ?? false}
            className="mt-0.5"
          />
          Exigir este campo no payload
        </label>
      </Field>

      <div>
        <SubmitButton>{regra ? 'Salvar regra' : 'Acrescentar regra'}</SubmitButton>
      </div>
    </ActionForm>
  )
}
