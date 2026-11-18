'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/session'
import { modoLocal } from '@/lib/db/modo'
import { mensagemDeErro } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

const convidarSchema = z.object({
  email: z.string().trim().toLowerCase().email('Informe um e-mail válido.'),
  role: z.enum(['admin', 'gestor', 'atendente', 'solicitante']),
})

/**
 * Convida alguém para a empresa.
 *
 * ## A confirmação é a MESMA em três desfechos diferentes
 *
 * Convite emitido, endereço que já tem conta (em qualquer empresa), e convite
 * vivo já existente: a tela responde igual nos três.
 *
 * A tentação é dizer "este e-mail já tem conta" — é útil para quem administra e
 * transforma esta tela num verificador de contas da instalação INTEIRA. Um
 * administrador de uma empresa passaria a descobrir, um e-mail por vez, quem
 * mais usa o produto; e o `role` que ele pode escolher não limita isso em nada.
 *
 * Quem é dono do endereço descobre por e-mail, que é o único canal onde a
 * diferença pode aparecer sem informar terceiro nenhum. Mesma regra da 0060.
 */
export async function convidar(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const guarda = await requirePermission('usuarios.convites.criar')
  if ('error' in guarda) return guarda
  const { profile } = guarda.ctx

  const parsed = convidarSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  if (!modoLocal()) return { error: 'Convites não estão disponíveis neste ambiente.' }

  const admin = createAdminClient()
  const { error } = await admin.schema('app').rpc('convidar_para_empresa', {
    p_tenant: profile.tenant_id,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
    p_por: profile.id,
  })

  if (error) {
    /*
     * A recusa de papel acima do próprio APARECE, e isso não contradiz a regra
     * acima: ela fala do que quem está logado pode fazer, não de quem existe no
     * banco. Esconder essa viraria um formulário que recusa em silêncio.
     */
    if (/insufficient_privilege|acima do seu/i.test(error.message)) {
      return { error: 'Você não pode convidar alguém para um papel acima do seu.' }
    }
    console.error('[convites] falha ao convidar:', error.message)
    return { error: mensagemDeErro(error) }
  }

  revalidatePath('/usuarios/convites')
  return { success: 'Se este endereço ainda não tiver conta, o convite já está a caminho.' }
}

/** Revoga um convite que ainda não foi aceito. */
export async function revogar(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const guarda = await requirePermission('usuarios.convites.revogar')
  if ('error' in guarda) return guarda

  const id = Number(formData.get('id'))
  if (!Number.isFinite(id)) return { error: 'Convite inválido.' }

  /*
   * Pelo cliente do USUÁRIO, e não pelo de serviço: a policy da 0061 é que
   * garante que ele só revoga convite da própria empresa, e só o que ainda não
   * foi aceito. Usar a chave de serviço aqui passaria por cima dela e deixaria
   * a regra morando só nesta função.
   */
  const supabase = await createClient()
  const { error } = await supabase
    .from('invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return { error: mensagemDeErro(error) }

  revalidatePath('/usuarios/convites')
  return { success: 'Convite revogado. O link deixa de valer agora.' }
}
