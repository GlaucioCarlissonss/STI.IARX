'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import type {
  Client,
  OperationLocation,
  RentalAllocation,
  RentalContract,
} from '@/lib/types'
import { ESTADO_DO_CONTRATO } from '@/lib/locacao/rotulos'
import type { RentalContractStatus } from '@/lib/types'
import {
  alocarEquipamento,
  moverAlocacao,
  moverContrato,
  salvarContrato,
  salvarLocal,
} from './actions'

export function ContratoForm({
  contrato,
  clientes,
}: {
  contrato?: RentalContract
  clientes: Client[]
}) {
  const uid = contrato ? `ctr-${contrato.id}` : 'ctr-novo'
  return (
    <ActionForm action={salvarContrato} manterCampos={Boolean(contrato)} className="flex flex-col gap-4">
      {contrato && <input type="hidden" name="id" value={contrato.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Número do contrato" htmlFor={`${uid}-cod`} required>
          <input id={`${uid}-cod`} name="code" required maxLength={40}
            defaultValue={contrato?.code ?? ''} className={inputClass} placeholder="CTR-2026-018" />
        </Field>
        <Field label="Cliente" htmlFor={`${uid}-cli`} required>
          <select id={`${uid}-cli`} name="client_id" required
            defaultValue={contrato?.client_id ?? ''} className={inputClass}>
            <option value="">Selecione…</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>{c.trade_name ?? c.legal_name}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Início" htmlFor={`${uid}-ini`} required>
          <input id={`${uid}-ini`} name="starts_on" type="date" required
            defaultValue={contrato?.starts_on ?? ''} className={inputClass} />
        </Field>
        <Field label="Fim" htmlFor={`${uid}-fim`} hint="Em branco = indeterminado.">
          <input id={`${uid}-fim`} name="ends_on" type="date"
            defaultValue={contrato?.ends_on ?? ''} className={inputClass} />
        </Field>
        <Field label="Dia de fechamento" htmlFor={`${uid}-dia`} required
          hint="Quando a competência fecha — não é o vencimento.">
          <input id={`${uid}-dia`} name="billing_day" type="number" min="1" max="28" required
            defaultValue={contrato?.billing_day ?? 1} className={inputClass} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Franquia padrão" htmlFor={`${uid}-fr`}
          hint="O que já está incluso no preço. Cada item pode divergir — e diverge: equipamento mais pesado costuma vir com franquia maior.">
          <input id={`${uid}-fr`} name="default_franchise" type="number" step="0.01" min="0"
            defaultValue={contrato?.default_franchise ?? ''} className={inputClass} />
        </Field>
        <Field label="Preço do excedente" htmlFor={`${uid}-ex`} hint="Por unidade de medidor acima da franquia.">
          <input id={`${uid}-ex`} name="default_excess_price" type="number" step="0.0001" min="0"
            defaultValue={contrato?.default_excess_price ?? ''} className={inputClass} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Índice de reajuste" htmlFor={`${uid}-idx`}
          hint="Registrado, não calculado: o sistema não tem a série do índice, e um número inventado seria pior que um campo descritivo.">
          <input id={`${uid}-idx`} name="adjustment_index" maxLength={40}
            defaultValue={contrato?.adjustment_index ?? ''} className={inputClass} placeholder="IPCA" />
        </Field>
        <Field label="Mês do reajuste" htmlFor={`${uid}-mes`}>
          <input id={`${uid}-mes`} name="adjustment_month" type="number" min="1" max="12"
            defaultValue={contrato?.adjustment_month ?? ''} className={inputClass} />
        </Field>
      </div>

      <Field label="Observações" htmlFor={`${uid}-obs`}>
        <textarea id={`${uid}-obs`} name="notes" rows={2} maxLength={2000}
          defaultValue={contrato?.notes ?? ''} className={inputClass} />
      </Field>

      <SubmitButton pendingLabel="Salvando…">
        {contrato ? 'Salvar contrato' : 'Criar contrato'}
      </SubmitButton>
    </ActionForm>
  )
}

/** Os botões de estado do contrato, lidos da tabela de transições. */
export function MoverContratoForm({
  id,
  destinos,
}: {
  id: string
  destinos: { status: string; rotulo: string | null }[]
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {destinos.map((d) => {
        const estado = ESTADO_DO_CONTRATO[d.status as RentalContractStatus]
        const perigoso = d.status === 'cancelled' || d.status === 'ended'
        return (
          <ActionForm key={d.status} action={moverContrato}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="status" value={d.status} />
            <span title={d.rotulo ?? undefined}>
              <SubmitButton variant={perigoso ? 'danger' : 'secondary'} pendingLabel="Movendo…">
                {estado?.label ?? d.status}
              </SubmitButton>
            </span>
          </ActionForm>
        )
      })}
    </div>
  )
}

export function AlocarForm({
  contratoId,
  disponiveis,
  locais,
  franquiaPadrao,
  excedentePadrao,
}: {
  contratoId: string
  disponiveis: { id: string; asset_tag: string; nome: string; preco: number | null }[]
  locais: OperationLocation[]
  franquiaPadrao: number | null
  excedentePadrao: number | null
}) {
  if (disponiveis.length === 0) {
    return (
      <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
        Nenhum equipamento disponível para alocar. Peça em manutenção, bloqueada ou já alocada em
        outro contrato não aparece aqui — é a mesma regra que o banco impõe.
      </p>
    )
  }
  return (
    <ActionForm action={alocarEquipamento} className="flex flex-col gap-3">
      <input type="hidden" name="contract_id" value={contratoId} />
      <Field label="Equipamento" htmlFor={`aloc-${contratoId}`} required>
        <select id={`aloc-${contratoId}`} name="equipment_id" required className={inputClass}>
          <option value="">Selecione…</option>
          {disponiveis.map((e) => (
            <option key={e.id} value={e.id}>
              {e.asset_tag} — {e.nome}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Local de operação" htmlFor={`local-${contratoId}`}
        hint="Onde a máquina vai ficar ligada. É por ele que a entrega e o recolhimento se orientam.">
        <select id={`local-${contratoId}`} name="operation_location_id" className={inputClass}>
          <option value="">Sem local definido</option>
          {locais.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Preço acordado" htmlFor={`preco-${contratoId}`} required
          hint="Congelado no item: reajustar a tabela não muda o que este contrato cobra.">
          <input id={`preco-${contratoId}`} name="monthly_price" type="number" step="0.01" min="0"
            required className={inputClass} />
        </Field>
        <Field label="Franquia" htmlFor={`fr-${contratoId}`}>
          <input id={`fr-${contratoId}`} name="franchise" type="number" step="0.01" min="0"
            defaultValue={franquiaPadrao ?? ''} className={inputClass} />
        </Field>
        <Field label="Excedente" htmlFor={`ex-${contratoId}`}>
          <input id={`ex-${contratoId}`} name="excess_price" type="number" step="0.0001" min="0"
            defaultValue={excedentePadrao ?? ''} className={inputClass} />
        </Field>
      </div>
      <SubmitButton pendingLabel="Alocando…">Alocar equipamento</SubmitButton>
    </ActionForm>
  )
}

/**
 * Os passos da alocação: expedir → entregar → recolher.
 *
 * Um botão por passo, com o número do medidor onde ele importa. Entregar e
 * recolher pedem a leitura porque é dela que sai o consumo do período — e o
 * banco exige a data, que a ação preenche com hoje.
 */
export function PassoDaAlocacaoForm({ alocacao }: { alocacao: RentalAllocation }) {
  const pedeLeitura = alocacao.meter_kind !== 'none'

  if (alocacao.status === 'reserved' && alocacao.equipment_status === 'reserved') {
    return (
      <div className="flex flex-wrap gap-2">
        <ActionForm action={moverAlocacao}>
          <input type="hidden" name="id" value={alocacao.id} />
          <input type="hidden" name="equipment_id" value={alocacao.equipment_id} />
          <input type="hidden" name="acao" value="expedir" />
          <SubmitButton variant="secondary" pendingLabel="Expedindo…">Expedir</SubmitButton>
        </ActionForm>
        <ActionForm action={moverAlocacao}>
          <input type="hidden" name="id" value={alocacao.id} />
          <input type="hidden" name="equipment_id" value={alocacao.equipment_id} />
          <input type="hidden" name="acao" value="cancelar" />
          <SubmitButton variant="danger" pendingLabel="Cancelando…">Cancelar alocação</SubmitButton>
        </ActionForm>
      </div>
    )
  }

  if (alocacao.status === 'reserved' && alocacao.equipment_status === 'in_transit_out') {
    return (
      <ActionForm action={moverAlocacao} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={alocacao.id} />
        <input type="hidden" name="equipment_id" value={alocacao.equipment_id} />
        <input type="hidden" name="acao" value="entregar" />
        {pedeLeitura && (
          <Field label="Medidor na entrega" htmlFor={`ent-${alocacao.id}`}>
            <input id={`ent-${alocacao.id}`} name="meter" type="number" step="1" min="0"
              defaultValue={alocacao.meter_reading} className={`${inputClass} w-32`} />
          </Field>
        )}
        <SubmitButton pendingLabel="Confirmando…">Confirmar entrega</SubmitButton>
      </ActionForm>
    )
  }

  if (alocacao.status === 'delivered') {
    return (
      <ActionForm action={moverAlocacao} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={alocacao.id} />
        <input type="hidden" name="equipment_id" value={alocacao.equipment_id} />
        <input type="hidden" name="acao" value="recolher" />
        {pedeLeitura && (
          <Field label="Medidor no recolhimento" htmlFor={`rec-${alocacao.id}`}>
            <input id={`rec-${alocacao.id}`} name="meter" type="number" step="1"
              min={alocacao.meter_at_delivery ?? 0}
              defaultValue={alocacao.meter_reading} className={`${inputClass} w-32`} />
          </Field>
        )}
        <SubmitButton variant="secondary" pendingLabel="Recolhendo…">Recolher</SubmitButton>
      </ActionForm>
    )
  }

  return null
}

export function LocalForm({
  clientId,
  atual,
}: {
  clientId: string
  atual?: OperationLocation
}) {
  const uid = atual ? `loc-${atual.id}` : `loc-novo-${clientId}`
  return (
    <ActionForm action={salvarLocal} manterCampos={Boolean(atual)} className="flex flex-col gap-3">
      {atual && <input type="hidden" name="id" value={atual.id} />}
      <input type="hidden" name="client_id" value={clientId} />
      <Field label="Nome do local" htmlFor={`${uid}-nome`} required
        hint="Como quem entrega vai encontrar: “Unidade Centro”, “3º andar — UTI”.">
        <input id={`${uid}-nome`} name="name" required maxLength={120}
          defaultValue={atual?.name ?? ''} className={inputClass} />
      </Field>
      <Field label="Endereço" htmlFor={`${uid}-end`}>
        <input id={`${uid}-end`} name="address_line" maxLength={200}
          defaultValue={atual?.address_line ?? ''} className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Contato" htmlFor={`${uid}-ct`}>
          <input id={`${uid}-ct`} name="contact_name" maxLength={120}
            defaultValue={atual?.contact_name ?? ''} className={inputClass} />
        </Field>
        <Field label="Telefone" htmlFor={`${uid}-tel`}>
          <input id={`${uid}-tel`} name="contact_phone" maxLength={40}
            defaultValue={atual?.contact_phone ?? ''} className={inputClass} />
        </Field>
      </div>
      <SubmitButton pendingLabel="Salvando…">{atual ? 'Salvar local' : 'Cadastrar local'}</SubmitButton>
    </ActionForm>
  )
}
