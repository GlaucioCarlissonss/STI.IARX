'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSession, canManageRecords } from '@/lib/session'
import type { ActionState } from '@/app/(app)/tickets/actions'
import { emptyToNull, optionalNumberInRange } from '@/lib/form-schemas'

const supplierSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do fornecedor.'),
  legal_name: emptyToNull,
  cnpj: emptyToNull,
  email: emptyToNull.pipe(z.union([z.string().email('E-mail inválido.'), z.null()])),
  phone: emptyToNull,
  // Serviços chegam como texto separado por vírgula e viram text[] no banco.
  services: z
    .string()
    .trim()
    .transform((v) =>
      v === '' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean),
    ),
  rating: optionalNumberInRange(0, 5),
})

export async function createSupplier(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()
  if (!canManageRecords(profile.role)) return { error: 'Sem permissão.' }

  const parsed = supplierSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('suppliers')
    .insert({ ...parsed.data, tenant_id: profile.tenant_id })

  if (error) {
    if (error.code === '23505') return { error: 'Já existe um fornecedor com este CNPJ.' }
    return { error: error.message }
  }

  revalidatePath('/fornecedores')
  return { success: 'Fornecedor cadastrado.' }
}
