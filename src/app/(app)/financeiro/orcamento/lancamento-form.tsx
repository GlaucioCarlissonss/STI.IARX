'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/action-form'
import { Card, ErrorNote, Field, inputClass } from '@/components/ui'
import { paraExibicao } from '@/lib/projetos/competencia'
import { emReais, ratear, somar } from '@/lib/orcamento/rateio'
import { importarTitulos, lancarCusto, type ImportacaoState } from './actions'

interface Opcao {
  id: string
  name: string
}

/**
 * Lançar custo e importar títulos.
 *
 * ## A prévia das parcelas aparece antes de gravar
 *
 * `ratear()` roda no navegador só para mostrar; quem divide de verdade é
 * `app.ratear_valor()`, no banco. As duas concordam, e há teste dos dois lados —
 * mas a prévia existe porque "R$ 1.000,01 em 7" é exatamente o caso em que
 * alguém quer ver os centavos antes de confirmar.
 */
export function LancamentoForm({
  clientId,
  scenarioId,
  competencia,
  fechada,
  categorias,
  filiais,
  fornecedores,
  centros,
}: {
  clientId: string
  scenarioId: string
  competencia: string
  fechada: boolean
  categorias: Opcao[]
  filiais: Opcao[]
  fornecedores: Opcao[]
  centros: Opcao[]
}) {
  const [state, formAction] = useActionState(lancarCusto, {})
  const [importacao, importarAction] = useActionState<ImportacaoState, FormData>(
    importarTitulos,
    {},
  )

  const [natureza, setNatureza] = useState('pontual_unica')
  const [valor, setValor] = useState('')
  const [parcelas, setParcelas] = useState('2')
  const [valorETotal, setValorETotal] = useState(true)

  const numero = Number(valor.replace(',', '.'))
  const n = Number(parcelas)
  const previa =
    natureza === 'pontual_parcelada' && Number.isFinite(numero) && numero > 0 && n >= 2 && n <= 360
      ? valorETotal
        ? ratear(numero, n)
        : Array.from({ length: n }, () => numero)
      : []

  if (fechada) {
    return (
      <Card title="Lançar custo">
        <p className="text-sm text-[var(--color-ink-2)]">
          A competência {paraExibicao(competencia)} está <strong>fechada</strong>. Nenhum lançamento
          entra nela — nem por importação. Reabra-a, com motivo, antes de lançar.
        </p>
      </Card>
    )
  }

  return (
    <>
      <Card title="Importar os títulos a pagar desta competência" className="mb-6">
        <p className="mb-3 text-sm text-[var(--color-ink-2)]">
          Traz para o orçamento os títulos a pagar que vencem em{' '}
          <strong>{paraExibicao(competencia)}</strong>, com a categoria, a filial e o fornecedor que
          eles já têm. <strong>Rodar duas vezes não duplica nada</strong> — cada título vira
          lançamento uma vez só.
        </p>
        <form action={importarAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="scenario_id" value={scenarioId} />
          <input type="hidden" name="competence" value={competencia} />
          <SubmitButton pendingLabel="Importando…" variant="secondary">
            Importar títulos de {paraExibicao(competencia)}
          </SubmitButton>
        </form>
        {importacao.error && <ErrorNote>{importacao.error}</ErrorNote>}
        {importacao.success && (
          <p role="status" className="mt-2 text-sm text-[var(--color-ok-ink)]">
            {importacao.success}
            {importacao.resumo && importacao.resumo.importados > 0 && (
              <> Somam {emReais(Number(importacao.resumo.valor_total))}.</>
            )}
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--color-ink-3)]">
          Só entram títulos com categoria de despesa preenchida e filial deste cliente. Título
          recusado não entra.
        </p>
      </Card>

      <Card title="Lançar custo">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="scenario_id" value={scenarioId} />
          <input type="hidden" name="competence" value={competencia} />

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Categoria" htmlFor="expense_category_id" required>
              <select
                id="expense_category_id"
                name="expense_category_id"
                defaultValue=""
                required
                className={inputClass}
              >
                <option value="" disabled>
                  Escolha…
                </option>
                {categorias.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Filial" htmlFor="branch_id" hint="Em branco: custo do grupo inteiro.">
              <select id="branch_id" name="branch_id" defaultValue="" className={inputClass}>
                <option value="">Do grupo</option>
                {filiais.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Valor (R$)" htmlFor="amount" required>
              <input
                id="amount"
                name="amount"
                type="number"
                step="0.01"
                min="0"
                required
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Natureza" htmlFor="natureza">
              <select
                id="natureza"
                name="natureza"
                value={natureza}
                onChange={(e) => setNatureza(e.target.value)}
                className={inputClass}
              >
                <option value="pontual_unica">Pontual — uma vez só</option>
                <option value="fixa">Fixa — repete todo mês</option>
                <option value="pontual_parcelada">Parcelada</option>
              </select>
            </Field>

            <Field
              label="Classificação"
              htmlFor="classificacao"
              hint="Investimento vira ativo; despesa é custo corrente."
            >
              <select
                id="classificacao"
                name="classificacao"
                defaultValue="despesa"
                className={inputClass}
              >
                <option value="despesa">Despesa</option>
                <option value="investimento">Investimento</option>
              </select>
            </Field>

            <Field
              label="Consumo"
              htmlFor="consumo"
              hint="Compartilhado: esta filial paga, outras usam."
            >
              <select id="consumo" name="consumo" defaultValue="integral" className={inputClass}>
                <option value="integral">Integral — é todo desta filial</option>
                <option value="compartilhado">Compartilhado — outras consomem</option>
              </select>
            </Field>
          </div>

          {natureza === 'pontual_parcelada' && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Quantas parcelas" htmlFor="installment_total" required>
                  <input
                    id="installment_total"
                    name="installment_total"
                    type="number"
                    min={2}
                    max={360}
                    required
                    value={parcelas}
                    onChange={(e) => setParcelas(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <label className="flex items-start gap-2.5 pt-7 text-sm text-[var(--color-ink)]">
                  <input
                    type="checkbox"
                    name="valor_e_total"
                    checked={valorETotal}
                    onChange={(e) => setValorETotal(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    O valor acima é o <strong>total do contrato</strong>
                    <span className="block text-xs text-[var(--color-ink-3)]">
                      Desmarcado, ele é o valor de <strong>cada</strong> parcela. As duas leituras
                      existem — &ldquo;R$ 12.000 em 12x&rdquo; e &ldquo;12x de R$ 1.000&rdquo; — e
                      supor uma delas erraria o total por doze.
                    </span>
                  </span>
                </label>
              </div>

              {previa.length > 0 && (
                <div className="mt-3 text-xs text-[var(--color-ink-2)]">
                  <p className="font-semibold">
                    {previa.length} parcelas, somando {emReais(somar(previa))}:
                  </p>
                  <p className="mt-1 tabular-nums">
                    {previa.slice(0, 6).map((v) => emReais(v)).join(' · ')}
                    {previa.length > 6 && ` … (+${previa.length - 6})`}
                  </p>
                  {valorETotal && previa[0] !== previa[previa.length - 1] && (
                    <p className="mt-1 text-[var(--color-ink-3)]">
                      O resto vai nas primeiras parcelas, para a soma fechar exatamente no total.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {natureza === 'fixa' && (
            <Field
              label="Repetir até"
              htmlFor="recurrence_until"
              hint="Em branco: em aberto — projeta 24 meses à frente. Encerrar um contrato é cadastrar a vigência dele."
            >
              <input
                id="recurrence_until"
                name="recurrence_until"
                type="month"
                className={inputClass}
              />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Descrição" htmlFor="description">
              <input id="description" name="description" maxLength={400} className={inputClass} />
            </Field>
            <Field label="Fornecedor" htmlFor="supplier_id">
              <select id="supplier_id" name="supplier_id" defaultValue="" className={inputClass}>
                <option value="">—</option>
                {fornecedores.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Centro de custo" htmlFor="cost_center_id">
              <select
                id="cost_center_id"
                name="cost_center_id"
                defaultValue=""
                className={inputClass}
              >
                <option value="">—</option>
                {centros.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {state.error && <ErrorNote>{state.error}</ErrorNote>}
          {state.success && (
            <p role="status" className="text-sm text-[var(--color-ok-ink)]">
              {state.success}
            </p>
          )}

          <SubmitButton pendingLabel="Lançando…">
            Lançar em {paraExibicao(competencia)}
          </SubmitButton>
        </form>
      </Card>
    </>
  )
}
