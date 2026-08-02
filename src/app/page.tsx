import { redirect } from 'next/navigation'
import { getSessionContext } from '@/lib/session'

export default async function Home() {
  const ctx = await getSessionContext()
  redirect(ctx ? '/painel' : '/login')
}
