'use client'

import { ActionForm, SubmitButton } from '@/components/action-form'
import { Field, inputClass } from '@/components/ui'
import { TIPO_DO_ATENDIMENTO, QUEM_PAGA } from '@/lib/locacao/rotulos'
import type { FieldServiceKind } from '@/lib/types'
import {
  abrirAtendimento,
  apontarHoras,
  apontarPeca,
  aprovarCusto,
  moverAtendimento,
  removerApontamento,
  revogarAprovacao,
  salvarCampo,
} from './actions'

const TIPOS = Object.keys(TIPO_DO_ATENDIMENTO) as FieldServiceKind[]

function SeletorDeTipo({ valor }: { valor?: FieldServiceKind }) {
  return (
    <Field label="Tipo de atendimento" htmlFor="ms-kind" required>
      <select id="ms-kind" name="kind" required defaultValue={valor ?? 'corrective'} className={inputClass}>
        {TIPOS.map((k) => (
          <option key={k} value={k}>
            {TIPO_DO_ATENDIMENTO[k].label} — {TIPO_DO_ATENDIMENTO[k].resumo}
          </option>
        ))}
      </select>
    </Field>
  )
}

function SeletorDeQuemPaga({ valor }: { valor?: 'provider' | 'client' }) {
  return (
    <Field
      label="Quem paga"
      htmlFor="ms-pagador"
      required
      hint="Garantia e desgaste são nossos; mau uso e fora de contrato são do cliente."
    >
      <select
        id="ms-pagador"
        name="billable_to"
        required
        defaultValue={valor ?? 'provider'}
        className={inputClass}
      >
        <option value="provider">{QUEM_PAGA.provider}</option>
        <option value="client">{QUEM_PAGA.client}</option>
      </select>
    </Field>
  )
}

function CampoDeAlcada({ valor }: { valor?: number | null }) {
  return (
    <Field
      label="Alçada de custo (R$)"
      htmlFor="ms-alcada"
      hint="Em branco = sem teto. Acima deste valor, fechar o atendimento exige aprovação."
    >
      <input
        id="ms-alcada"
        name="cost_limit"
        type="number"
        min="0"
        step="0.01"
        defaultValue={valor ?? ''}
        className={inputClass}
      />
    </Field>
  )
}

export function AbrirAtendimentoForm({
  equipamentos,
  prioridades,
}: {
  equipamentos: { id: string; asset_tag: string; modelo: string; situacao: string }[]
  prioridades: { id: string; name: string }[]
}) {
  if (equipamentos.length === 0) {
    return (
      <p className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
        Não há equipamento na frota para atender. Cadastre em Frota antes.
      </p>
    )
  }
  return (
    <ActionForm action={abrirAtendimento} className="flex flex-col gap-4">
      <Field label="Equipamento" htmlFor="ms-equip" required>
        <select id="ms-equip" name="equipment_id" required className={inputClass}>
          <option value="">Selecione…</option>
          {equipamentos.map((e) => (
            <option key={e.id} value={e.id}>
              {e.asset_tag} — {e.modelo} ({e.situacao})
            </option>
          ))}
        </select>
      </Field>

      <SeletorDeTipo />

      <Field label="O que está acontecendo" htmlFor="ms-titulo" required>
        <input
          id="ms-titulo"
          name="title"
          required
          minLength={5}
          maxLength={200}
          placeholder="Ex.: EQP-0412 atola a cada 20 páginas no tabuleiro 2"
          className={inputClass}
        />
      </Field>

      <Field label="Detalhes" htmlFor="ms-desc">
        <textarea id="ms-desc" name="description" rows={3} className={inputClass} />
      </Field>

      <Field label="Prioridade" htmlFor="ms-prio" required>
        <select id="ms-prio" name="priority_id" required className={inputClass}>
          {prioridades.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <SeletorDeQuemPaga />
      <CampoDeAlcada />

      <SubmitButton pendingLabel="Abrindo…">Abrir atendimento</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        O atendimento nasce como <strong>chamado</strong>, na fila de campo — com SLA, anexo,
        histórico e busca que já existem. Não há uma segunda lista de trabalho pendente.
      </p>
    </ActionForm>
  )
}

export function EditarCampoForm({
  ticketId,
  kind,
  billableTo,
  costLimit,
}: {
  ticketId: string
  kind: FieldServiceKind
  billableTo: 'provider' | 'client'
  costLimit: number | null
}) {
  return (
    <ActionForm action={salvarCampo} className="flex flex-col gap-4">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <SeletorDeTipo valor={kind} />
      <SeletorDeQuemPaga valor={billableTo} />
      <CampoDeAlcada valor={costLimit} />
      <SubmitButton pendingLabel="Salvando…">Salvar</SubmitButton>
    </ActionForm>
  )
}

export function ApontarHorasForm({
  ticketId,
  tecnicos,
}: {
  ticketId: string
  tecnicos: { id: string; full_name: string }[]
}) {
  const hoje = new Date().toISOString().slice(0, 10)
  return (
    <ActionForm action={apontarHoras} className="flex flex-col gap-3">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data" htmlFor="mh-data" required>
          <input
            id="mh-data"
            name="worked_on"
            type="date"
            required
            defaultValue={hoje}
            className={inputClass}
          />
        </Field>
        <Field label="Horas" htmlFor="mh-horas" required>
          <input
            id="mh-horas"
            name="hours"
            type="number"
            min="0.25"
            max="24"
            step="0.25"
            required
            className={inputClass}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Técnico" htmlFor="mh-tec">
          <select id="mh-tec" name="technician_id" className={inputClass}>
            <option value="">Eu mesmo</option>
            {tecnicos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Valor da hora (R$)" htmlFor="mh-valor">
          <input
            id="mh-valor"
            name="hourly_rate"
            type="number"
            min="0"
            step="0.01"
            className={inputClass}
          />
        </Field>
      </div>
      <Field label="O que foi feito" htmlFor="mh-notas">
        <input id="mh-notas" name="notes" maxLength={300} className={inputClass} />
      </Field>
      <SubmitButton pendingLabel="Apontando…">Apontar horas</SubmitButton>
    </ActionForm>
  )
}

export function ApontarPecaForm({ ticketId }: { ticketId: string }) {
  return (
    <ActionForm action={apontarPeca} className="flex flex-col gap-3">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <Field label="Peça" htmlFor="mp-desc" required>
        <input
          id="mp-desc"
          name="description"
          required
          minLength={3}
          maxLength={200}
          placeholder="Ex.: Kit de roletes de tração"
          className={inputClass}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantidade" htmlFor="mp-qtd" required>
          <input
            id="mp-qtd"
            name="quantity"
            type="number"
            min="0.001"
            step="0.001"
            defaultValue="1"
            required
            className={inputClass}
          />
        </Field>
        <Field label="Custo unitário (R$)" htmlFor="mp-custo">
          <input id="mp-custo" name="unit_cost" type="number" min="0" step="0.01" className={inputClass} />
        </Field>
      </div>
      <SubmitButton pendingLabel="Registrando…">Registrar peça</SubmitButton>
      <p className="text-xs text-[var(--color-ink-3)]">
        Apontar é sempre permitido, inclusive acima da alçada. O que a alçada trava é o
        <strong> fechamento</strong> — para que o custo real apareça em vez de sumir.
      </p>
    </ActionForm>
  )
}

export function AprovarCustoForm({ ticketId, custo }: { ticketId: string; custo: string }) {
  return (
    <ActionForm action={aprovarCusto} className="flex flex-col gap-3">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <Field
        label="Justificativa"
        htmlFor={`ap-${ticketId}`}
        hint="Fica no atendimento — é o que responde “quem autorizou isto?” seis meses depois."
      >
        <input id={`ap-${ticketId}`} name="approval_note" maxLength={300} className={inputClass} />
      </Field>
      <SubmitButton pendingLabel="Aprovando…">Aprovar {custo}</SubmitButton>
    </ActionForm>
  )
}

export function RevogarAprovacaoForm({ ticketId }: { ticketId: string }) {
  return (
    <ActionForm action={revogarAprovacao}>
      <input type="hidden" name="ticket_id" value={ticketId} />
      <SubmitButton variant="secondary" pendingLabel="Revogando…">
        Revogar aprovação
      </SubmitButton>
    </ActionForm>
  )
}

/**
 * Um botão por transição LEGAL — a lista vem da tabela de transições do banco.
 *
 * Desenhar só o que é possível é o que impede a tela de oferecer um caminho que
 * o gatilho vai recusar. O erro do servidor continua existindo (outra pessoa
 * pode mover o chamado no meio), mas ele deixa de ser o normal.
 */
export function MoverAtendimentoForm({
  ticketId,
  destinos,
}: {
  ticketId: string
  destinos: { status: string; label: string }[]
}) {
  if (destinos.length === 0) {
    return <p className="text-sm text-[var(--color-ink-3)]">Não há transição possível daqui.</p>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {destinos.map((d) => (
        <ActionForm key={d.status} action={moverAtendimento}>
          <input type="hidden" name="ticket_id" value={ticketId} />
          <input type="hidden" name="status" value={d.status} />
          <SubmitButton variant="secondary" pendingLabel="Movendo…">
            {d.label}
          </SubmitButton>
        </ActionForm>
      ))}
    </div>
  )
}

/** Remover um apontamento lançado por engano — ver `removerApontamento`. */
export function RemoverApontamentoForm({
  id,
  ticketId,
  tipo,
}: {
  id: string
  ticketId: string
  tipo: 'hora' | 'peca'
}) {
  return (
    <ActionForm action={removerApontamento}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="ticket_id" value={ticketId} />
      <input type="hidden" name="tipo" value={tipo} />
      <SubmitButton variant="secondary" pendingLabel="Removendo…">
        Remover
      </SubmitButton>
    </ActionForm>
  )
}
