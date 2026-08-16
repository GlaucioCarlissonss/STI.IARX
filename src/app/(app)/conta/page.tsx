import type { Metadata } from 'next'
import { requireSession } from '@/lib/session'
import { Card, PageHeader } from '@/components/ui'
import { ChangePasswordForm } from './change-password-form'

export const metadata: Metadata = { title: 'Minha conta' }

export default async function ContaPage() {
  const { profile } = await requireSession()

  return (
    <>
      <PageHeader title="Minha conta" description={`${profile.full_name} · ${profile.email}`} />

      <div className="max-w-md">
        <Card title="Trocar senha">
          <ChangePasswordForm />
        </Card>
      </div>
    </>
  )
}
