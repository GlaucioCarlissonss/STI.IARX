'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { emptyToNull, optionalUuid } from '@/lib/form-schemas'

const clientSchema = z.object({
  legal_name: z.string().trim().min(2, 'Informe a razão social.'),
  trade_name: emptyToNull,
  cnpj: emptyToNull,
  contract_ref: emptyToNull,
})

export async function createClientRecord(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = clientSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('clients')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um cliente com este CNPJ.' }
    return { error: error.message }
  }

  revalidatePath('/clientes')
  return { success: 'Cliente cadastrado.' }
}

const branchSchema = z.object({
  client_id: z.string().uuid('Selecione o cliente.'),
  name: z.string().trim().min(2, 'Informe o nome da filial.'),
  code: emptyToNull,
  cnpj: emptyToNull,
  city: emptyToNull,
  state: emptyToNull,
  // O timezone da filial é a base de todo cálculo de horário útil de SLA (ADR-004),
  // por isso é obrigatório e tem default explícito.
  timezone: z.string().trim().min(3, 'Selecione um fuso horário.'),
  business_hours_id: optionalUuid,
  contact_name: emptyToNull,
  contact_email: emptyToNull,
  contact_phone: emptyToNull,
})

export async function createBranch(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = branchSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('branches')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) return { error: error.message }

  revalidatePath('/clientes')
  return { success: 'Filial cadastrada.' }
}
