import type { Metadata } from 'next'
import { requireScreen, canWorkTickets } from '@/lib/session'
import { getAgents, getBranches, getCategories, getPriorities, getQueues, groupCategories } from '@/lib/data/lookups'
import { PageHeader } from '@/components/ui'
import { NewTicketForm } from './new-ticket-form'

export const metadata: Metadata = { title: 'Abrir ticket' }

export default async function NewTicketPage() {
  const { profile } = await requireScreen('helpdesk.tickets.criar')

  const [priorities, queues, categories, branches, agents] = await Promise.all([
    getPriorities(),
    getQueues(),
    getCategories(),
    getBranches(),
    getAgents(),
  ])

  return (
    <>
      <PageHeader
        title="Abrir ticket"
        description="O SLA é calculado automaticamente a partir da categoria, da prioridade e do contrato do cliente."
      />
      <div className="max-w-3xl">
        <NewTicketForm
          priorities={priorities}
          queues={queues}
          categoryGroups={groupCategories(categories)}
          branches={branches}
          agents={agents}
          canAssign={canWorkTickets(profile.role)}
        />
      </div>
    </>
  )
}
