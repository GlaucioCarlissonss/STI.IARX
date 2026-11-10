'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import { ESFERAS, ROTULO_DA_ESFERA } from '@/lib/esferas'

/*
 * Os limites são os MESMOS do banco, e isso é duplicação de propósito.
 *
 * O CHECK da tabela é a garantia — ele vale para o `update` à mão, para a
 * importação e para qualquer caminho que ainda não existe. O schema aqui é a
 * MENSAGEM: sem ele, digitar 150 em "percentual de atenção" devolve
 * "violates check constraint tenants_sla_warning_pct_check", que não diz a
 * ninguém o que fazer.
 *
 * Quando os dois divergirem, quem ganha é o banco — e o sintoma será uma
 * mensagem feia, não um dado inválido.
 */
const schema = z
  .object({
    sla_warning_pct: z.coerce.number().int().min(1).max(99),
    sla_critical_pct: z.coerce.number().int().min(1).max(99),
    auto_close_after_days: z.coerce.number().int().min(0).max(365),
    attachment_quota_mb: z.coerce.number().int().min(1).max(100000),
    payable_approval_required: z.coerce.boolean(),
    agent_disk_alert_pct: z.coerce.number().int().min(50).max(99),
    agent_mute_hours: z.coerce.number().int().min(1).max(720),
    agent_metrics_retention_days: z.coerce.number().int().min(1).max(90),
    contract_alert_days: z.coerce.number().int().min(1).max(365),
    link_alert_minutes: z.coerce.number().int().min(1).max(1440),
  })
  .refine((d) => d.sla_warning_pct < d.sla_critical_pct, {
    /* O banco também recusa (`tenants_warning_before_critical`). Esta mensagem
       diz por que a regra existe, que é o que evita a segunda tentativa igual. */
    message:
      'A atenção tem de vir antes do crítico: com a ordem invertida, o chamado entraria em crítico sem nunca ter passado por atenção.',
  })

/**
 * Salva as preferências de operação do ambiente.
 *
 * ## O que esta tela mexe, e o que ela não mexe
 *
 * Mexe em onze parâmetros que governam **quando o sistema age sozinho**: quando
 * avisa, quando fecha, quanto guarda. Não mexe em nada que o usuário veja
 * diretamente — nome, identidade visual e domínio não estão aqui, porque não
 * são operação.
 *
 * ## Por que `agent_remote_url` ficou de fora
 *
 * Ela é um template de URL com `{id}` dentro, validado por CHECK, e aponta para
 * a ferramenta de acesso remoto do cliente. Editá-la junto de percentuais e
 * prazos convidaria a colar ali qualquer coisa — e o erro só apareceria quando
 * alguém clicasse em "acessar remotamente" no meio de um atendimento.
 */
export async function salvarPreferencias(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('ambiente.preferencias.editar', {
    papel: 'config',
    mensagem: 'Sem permissão para alterar as preferências do ambiente.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = schema.safeParse({
    sla_warning_pct: formData.get('sla_warning_pct'),
    sla_critical_pct: formData.get('sla_critical_pct'),
    auto_close_after_days: formData.get('auto_close_after_days'),
    attachment_quota_mb: formData.get('attachment_quota_mb'),
    payable_approval_required: formData.get('payable_approval_required') === 'on',
    agent_disk_alert_pct: formData.get('agent_disk_alert_pct'),
    agent_mute_hours: formData.get('agent_mute_hours'),
    agent_metrics_retention_days: formData.get('agent_metrics_retention_days'),
    contract_alert_days: formData.get('contract_alert_days'),
    link_alert_minutes: formData.get('link_alert_minutes'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tenants')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', profile.tenant_id)
    /* Negação de RLS em UPDATE devolve ZERO LINHAS, não erro: sem o `select` e a
       checagem de tamanho, a tela diria "salvo" para quem não pode salvar. */
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/ambiente')
  return {
    success:
      'Preferências salvas. Elas passam a valer na próxima execução dos trabalhos agendados.',
  }
}

/**
 * Liga e desliga as esferas de negócio da empresa (migração 0047).
 *
 * ## Por que mora aqui, e não numa tela própria
 *
 * Porque é parâmetro do tenant, como os outros onze — e porque uma tela só para
 * dois interruptores daria a eles mais peso do que têm. O que muda é o peso do
 * EFEITO, não o da tela: ligar a locação faz aparecer um módulo inteiro.
 *
 * ## Desligar esconde, não apaga
 *
 * Nenhuma linha é tocada: a esfera desligada tira as telas do menu e as chaves
 * da matriz de permissão, e o dado continua no banco esperando. É deliberado —
 * desligar por engano custa um clique para desfazer, e não um restore.
 *
 * ## Desligar as duas é recusado em dois lugares
 *
 * Aqui, com mensagem; e no CHECK `tenants_spheres_not_empty`, sem mensagem. A
 * duplicação é a mesma dos percentuais acima: o banco é a garantia, isto é a
 * explicação. Empresa sem esfera nenhuma não teria tela nenhuma — nem esta, que
 * é onde se desfaria o engano.
 */
export async function salvarEsferas(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('ambiente.preferencias.editar', {
    papel: 'config',
    mensagem: 'Sem permissão para alterar as esferas da empresa.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  /* `getAll` porque são caixas de seleção com o mesmo nome: o navegador manda
     uma entrada por caixa marcada, e nenhuma quando todas estão vazias. */
  const escolhidas = ESFERAS.filter((e) => formData.getAll('esferas').includes(e))

  if (escolhidas.length === 0) {
    return {
      error:
        'A empresa precisa de ao menos uma esfera. Sem nenhuma, não sobraria tela alguma — nem esta, que é onde se desfaz a escolha.',
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tenants')
    .update({ spheres: escolhidas, updated_at: new Date().toISOString() })
    .eq('id', profile.tenant_id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  /* O menu vive no layout: sem o `'layout'`, a pessoa salvaria e continuaria
     vendo o menu antigo até trocar de tela — e concluiria que não funcionou. */
  revalidatePath('/', 'layout')
  return {
    success:
      escolhidas.length === 2
        ? 'As duas esferas estão ligadas. O seletor de foco aparece no cabeçalho.'
        : `Esfera de ${ROTULO_DA_ESFERA[escolhidas[0]!]} ligada. O menu já reflete a mudança.`,
  }
}
