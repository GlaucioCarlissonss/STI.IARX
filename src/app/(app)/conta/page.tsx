import type { Metadata } from 'next'
import { requireSession } from '@/lib/session'
import { createClient } from '@/lib/supabase/server'
import { Card, PageHeader } from '@/components/ui'
import { ChangePasswordForm } from './change-password-form'
import { TIPOS_DE_AVISO } from './avisos'
import { PreferenciasDeAviso } from './notificacoes-form'

export const metadata: Metadata = { title: 'Minha conta' }

export default async function ContaPage() {
  const { profile } = await requireSession()

  /* Só as linhas DESTA pessoa chegam: a policy `notification_preferences_own`
     compara `user_id` com `app.current_user_id()`. O filtro aqui é redundante de
     propósito — se um dia a policy mudar, a consulta continua certa. */
  const supabase = await createClient()
  const { data: preferencias } = await supabase
    .from('notification_preferences')
    .select('kind, enabled')
    .eq('user_id', profile.id)

  const estado = Object.fromEntries(
    (preferencias ?? []).map((p) => [p.kind as string, p.enabled as boolean]),
  )

  return (
    <>
      <PageHeader title="Minha conta" description={`${profile.full_name} · ${profile.email}`} />

      <div className="grid gap-6 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <Card title="Trocar senha">
          <ChangePasswordForm />
        </Card>

        <Card title="Avisos por e-mail">
          <PreferenciasDeAviso tipos={TIPOS_DE_AVISO} estado={estado} />
        </Card>
      </div>
    </>
  )
}
