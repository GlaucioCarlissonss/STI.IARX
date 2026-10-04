'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireSession } from '@/lib/session'
import type { ActionState } from '@/lib/actions/estado'
import { NAO_AFETADO } from '@/lib/actions/erros'
import { optionalUuid } from '@/lib/schemas/campos'

/**
 * Ações do layout — valem em qualquer tela, não pertencem a nenhuma.
 */

/**
 * Troca a empresa em foco.
 *
 * **Não tem chave de permissão, e isso é deliberado.** Escolher o que se olha é
 * preferência de quem usa, não autoridade sobre dado: o foco só ESTREITA o que
 * já estaria visível, e quem alcança a lista de empresas só alcança as do
 * próprio tenant (RLS). Exigir uma chave aqui criaria a situação absurda de
 * alguém enxergar cinco empresas e não poder se concentrar em uma.
 *
 * A fronteira de verdade está em dois lugares, nenhum deles aqui: a policy
 * `profiles_update` só deixa a pessoa escrever na própria linha, e a FK composta
 * `(focused_client_id, tenant_id)` da migração 0027 recusa um cliente de outro
 * tenant no banco, antes de qualquer validação de aplicação.
 */
export async function definirFocoDeCliente(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { profile } = await requireSession()

  const foco = optionalUuid.safeParse(formData.get('client_id') ?? '')
  if (!foco.success) return { error: foco.error.issues[0].message }

  const supabase = await createClient()
  const { data } = await supabase
    .from('profiles')
    .update({ focused_client_id: foco.data })
    .eq('id', profile.id)
    .select('id')

  if (!data?.length) return { error: NAO_AFETADO }

  // `'layout'`: o foco muda o conteúdo de TODA tela, não só da atual.
  revalidatePath('/', 'layout')

  return { success: foco.data ? 'Foco alterado.' : 'Mostrando todas as empresas.' }
}
