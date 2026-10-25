/**
 * Os tipos de aviso que a pessoa pode desligar.
 *
 * Mora num arquivo próprio, e não junto da Server Action, por uma razão que o
 * build não pega e a execução pega: **um módulo `'use server'` só pode exportar
 * funções assíncronas.** Exportar esta constante de lá compilava e derrubava a
 * rota `/conta` com "Failed to collect configuration" — erro que não aponta para
 * a causa e só aparece ao abrir a página.
 *
 * O fechamento automático de chamado NÃO está aqui, e não é esquecimento: ele
 * não manda e-mail nenhum. Oferecer um interruptor para desligar algo que não
 * acontece seria configuração morta — o mesmo defeito que esta base já corrigiu
 * seis vezes no catálogo de permissões.
 */
export const TIPOS_DE_AVISO = [
  {
    kind: 'sla_warning',
    label: 'Prazo de SLA se aproximando',
    hint: 'Quando o chamado passa do percentual de atenção configurado pelo tenant.',
  },
  {
    kind: 'sla_critical',
    label: 'Prazo de SLA crítico',
    hint: 'Quando o chamado chega perto de estourar.',
  },
  {
    kind: 'sla_breach',
    label: 'Prazo de SLA estourado',
    hint: 'Quando o prazo de resolução já foi ultrapassado.',
  },
  {
    kind: 'satisfaction_invite',
    label: 'Convite para avaliar atendimento',
    hint: 'Chega a quem abriu o chamado, depois do encerramento.',
  },
  {
    kind: 'contract_expiring',
    label: 'Contrato prestes a vencer',
    hint: 'Contrato de fornecedor, contrato de link e fim de fidelidade. Chega a gestores e administradores.',
  },
  {
    kind: 'link_down',
    label: 'Link de internet fora do ar',
    hint: 'Quando uma queda passa do limiar configurado no ambiente. Chega a gestores e administradores.',
  },
  {
    kind: 'link_restored',
    label: 'Link de internet de volta',
    hint: 'Só para queda que foi avisada — ninguém precisa saber do retorno de uma oscilação que não soube que houve.',
  },
  {
    kind: 'agent_alert',
    label: 'Alertas do agente de inventário',
    hint: 'Disco cheio, máquina sem contato, serviço fora do ar e disco com defeito. Chega a gestores e administradores.',
  },
] as const

export const KINDS_DE_AVISO = TIPOS_DE_AVISO.map((t) => t.kind)
