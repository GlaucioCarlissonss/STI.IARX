'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { uuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'
import {
  artigoSugeridoSchema,
  respostaSugeridaSchema,
  triagemSugeridaSchema,
  EXPLICACAO_DA_INDISPONIBILIDADE,
  credencialDaIA,
  type ConfigDeIA,
  type ContextoDoChamado,
  type TipoDeSugestao,
} from '@/lib/ia/tipos'
import { porQueNaoPosso, resolverTriagem } from '@/lib/ia/regras'
import { pedirAoProvedor } from '@/lib/ia/provedor'
import {
  SISTEMA_DA_RESPOSTA,
  SISTEMA_DA_TRIAGEM,
  SISTEMA_DO_ARTIGO,
  perguntaDaResposta,
  perguntaDaTriagem,
  perguntaDoArtigo,
} from '@/lib/ia/prompts'

/**
 * Pedir, aceitar e recusar uma sugestão.
 *
 * ## A ordem das operações, que é o desenho inteiro
 *
 * 1. permissão (`ia.sugestoes.usar`);
 * 2. **pode chamar?** — configuração ligada, recurso ligado, orçamento de pé,
 *    variável de ambiente existindo. Tudo antes de gastar: depois já gastou;
 * 3. contexto do chamado, com a filtragem de nota interna decidida no banco;
 * 4. a chamada;
 * 5. **registrar o consumo, mesmo que o resto falhe** — o provedor cobrou;
 * 6. gravar a sugestão como `pendente`.
 *
 * O passo 6 nunca é "aplicar". Aceitar é outra ação, com outro clique, e fica
 * registrado quem aceitou.
 */

const pedidoSchema = z.object({
  ticket_id: uuid,
  tipo: z.enum(['resposta', 'triagem', 'artigo']),
})

export interface SugestaoActionState extends ActionState {
  /** Quando a IA não está disponível, por quê — a tela escreve diferente para cada. */
  indisponivel?: string
}

async function configDoTenant(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<ConfigDeIA | null> {
  const { data } = await supabase.rpc('ai_config_utilizavel').maybeSingle<ConfigDeIA>()
  return data ?? null
}

/**
 * Pede uma sugestão ao provedor e a grava como pendente.
 */
export async function pedirSugestao(
  _prev: SugestaoActionState,
  formData: FormData,
): Promise<SugestaoActionState> {
  const gate = await permitirEscrita('ia.sugestoes.usar', {
    mensagem: 'Sem permissão para pedir sugestões.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = pedidoSchema.safeParse({
    ticket_id: formData.get('ticket_id'),
    tipo: formData.get('tipo'),
  })
  if (!parsed.success) return { error: 'Pedido inválido.' }
  const { ticket_id, tipo } = parsed.data

  const supabase = await createClient()

  const config = await configDoTenant(supabase)
  const motivo = porQueNaoPosso(config, tipo as TipoDeSugestao)
  if (motivo) return { indisponivel: EXPLICACAO_DA_INDISPONIBILIDADE[motivo] }

  /* `porQueNaoPosso` já garantiu os dois, mas o TypeScript não sabe disso — e a
     alternativa (`!`) esconderia uma mudança futura naquela função. */
  const cfg = config!
  const credencial = credencialDaIA(cfg.secret_ref)
  if (!credencial) return { indisponivel: EXPLICACAO_DA_INDISPONIBILIDADE.variavel_ausente }

  const { data: contexto } = await supabase
    .rpc('ai_contexto_do_chamado', { p_ticket_id: ticket_id })
    .maybeSingle<ContextoDoChamado>()
  if (!contexto) return { error: 'Chamado não encontrado.' }

  /* Monta prompt e esquema conforme o tipo. O `switch` é exaustivo por `tipo`
     porque `TipoDeSugestao` é união fechada: um tipo novo sem prompt não
     compila. */
  let system: string
  let pergunta: string
  let esquema: typeof respostaSugeridaSchema | typeof triagemSugeridaSchema | typeof artigoSugeridoSchema
  let categorias: { id: string; name: string }[] = []
  let prioridades: { id: string; key: string; label: string }[] = []

  if (tipo === 'resposta') {
    /* Os artigos vêm de `kb_sugestoes()` (0033) — a mesma função que o painel
       usa sem IA nenhuma. A IA não substitui a busca: ela lê o que a busca
       achou. */
    const { data: artigosBrutos } = await supabase.rpc('kb_sugestoes', {
      p_ticket_id: ticket_id,
      p_limite: 5,
    })
    /* O cliente Supabase não tem o tipo desta função — mesma situação de
       `/tickets/[id]/page.tsx`, onde o molde também é declarado à mão. */
    const artigos = (artigosBrutos ?? []) as unknown as { title: string; resumo: string | null }[]
    system = SISTEMA_DA_RESPOSTA
    pergunta = perguntaDaResposta(contexto, artigos)
    esquema = respostaSugeridaSchema
  } else if (tipo === 'triagem') {
    const [{ data: cats }, { data: prios }] = await Promise.all([
      supabase
        .from('ticket_categories')
        /* `ticket_categories` não tem `key` nem `sort_order` — ela só tem `name`,
           e é por ele que a sugestão casa. */
        .select('id, name')
        .eq('is_active', true)
        .order('name')
        .returns<{ id: string; name: string }[]>(),
      supabase
        .from('ticket_priorities')
        .select('id, key, label')
        .eq('is_active', true)
        .order('sort_order')
        .returns<{ id: string; key: string; label: string }[]>(),
    ])
    categorias = cats ?? []
    prioridades = prios ?? []
    if (categorias.length === 0 && prioridades.length === 0) {
      return { error: 'Não há categoria nem prioridade cadastrada para classificar.' }
    }
    system = SISTEMA_DA_TRIAGEM
    pergunta = perguntaDaTriagem(contexto, categorias, prioridades)
    esquema = triagemSugeridaSchema
  } else {
    system = SISTEMA_DO_ARTIGO
    pergunta = perguntaDoArtigo(contexto)
    esquema = artigoSugeridoSchema
  }

  const resposta = await pedirAoProvedor({
    credencial,
    model: cfg.model,
    effort: cfg.effort,
    system,
    pergunta,
    esquema,
  })

  if (!resposta.ok) return { error: resposta.falha.mensagem }
  const { resultado } = resposta

  /*
   * Registrar o consumo ANTES de qualquer outra conferência.
   *
   * O provedor cobrou. Uma sugestão recusada por chave inexistente (logo abaixo)
   * custou o mesmo que uma aceita, e não contabilizá-la faria o teto mensal
   * deixar passar justamente as chamadas que deram errado — que são as que mais
   * se repetem, porque quem tentou vai tentar de novo.
   */
  await supabase.rpc('ai_registrar_uso', {
    p_tenant_id: profile.tenant_id,
    p_tokens_entrada: resultado.tokens_entrada,
    p_tokens_saida: resultado.tokens_saida,
    p_centavos: resultado.custo_centavos,
  })

  let payload: Record<string, unknown> = resultado.dados as Record<string, unknown>

  if (tipo === 'triagem') {
    const resolvida = resolverTriagem(
      resultado.dados as z.infer<typeof triagemSugeridaSchema>,
      categorias,
      prioridades,
    )
    if (!resolvida.ok) return { error: resolvida.erro }
    /* Guarda os ids resolvidos junto: aceitar não deve reabrir a conversa sobre
       qual categoria era "senha". */
    payload = {
      ...payload,
      category_id: resolvida.category_id,
      category_name: resolvida.category_name,
      priority_id: resolvida.priority_id,
      priority_name: resolvida.priority_name,
    }
  }

  /*
   * Uma pendente por chamado e por tipo (índice único parcial da 0035). Pedir de
   * novo substitui a anterior: a pessoa quer a sugestão nova, não duas.
   */
  await supabase
    .from('ai_suggestions')
    .delete()
    .eq('ticket_id', ticket_id)
    .eq('kind', tipo)
    .eq('status', 'pendente')

  const { data, error } = await supabase
    .from('ai_suggestions')
    .insert({
      tenant_id: profile.tenant_id,
      ticket_id,
      kind: tipo,
      payload,
      requested_by: profile.id,
      model: resultado.model,
      tokens_entrada: resultado.tokens_entrada,
      tokens_saida: resultado.tokens_saida,
      custo_centavos: resultado.custo_centavos,
    })
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/tickets/${ticket_id}`)
  return { success: 'Sugestão pronta. Leia antes de usar — nada foi aplicado.' }
}

const decisaoSchema = z.object({
  suggestion_id: uuid,
  ticket_id: uuid,
  decisao: z.enum(['aceita', 'recusada']),
})

/**
 * Aceita ou recusa — e, na triagem aceita, aplica.
 *
 * ## Aplicar aqui, e não numa trigger
 *
 * A trigger rodaria com o dono da função e não com a pessoa, e o `ticket_history`
 * registraria a mudança sem autor — exatamente o que esta onda existe para
 * impedir. Aqui o `update` passa pelo RLS de quem clicou: se essa pessoa não pode
 * mudar a prioridade do chamado, a aceitação não acontece.
 */
export async function decidirSugestao(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const gate = await permitirEscrita('ia.sugestoes.usar', {
    mensagem: 'Sem permissão para decidir sugestões.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = decisaoSchema.safeParse({
    suggestion_id: formData.get('suggestion_id'),
    ticket_id: formData.get('ticket_id'),
    decisao: formData.get('decisao'),
  })
  if (!parsed.success) return { error: 'Decisão inválida.' }
  const { suggestion_id, ticket_id, decisao } = parsed.data

  const supabase = await createClient()

  const { data: sugestao } = await supabase
    .from('ai_suggestions')
    .select('id, kind, payload, status')
    .eq('id', suggestion_id)
    .maybeSingle<{
      id: string
      kind: string
      payload: Record<string, unknown>
      status: string
    }>()

  if (!sugestao) return { error: 'Sugestão não encontrada.' }
  if (sugestao.status !== 'pendente') return { error: 'Esta sugestão já foi decidida.' }

  if (decisao === 'aceita' && sugestao.kind === 'triagem') {
    const mudanca: Record<string, string> = {}
    if (typeof sugestao.payload.category_id === 'string') {
      mudanca.category_id = sugestao.payload.category_id
    }
    if (typeof sugestao.payload.priority_id === 'string') {
      mudanca.priority_id = sugestao.payload.priority_id
    }
    if (Object.keys(mudanca).length === 0) {
      return { error: 'A sugestão não tem o que aplicar.' }
    }

    const { data: aplicado, error: erroAoAplicar } = await supabase
      .from('tickets')
      .update(mudanca)
      .eq('id', ticket_id)
      .select('id')

    if (erroAoAplicar) return { error: mensagemDeErro(erroAoAplicar) }
    /* Zero linhas = o RLS negou. Marcar a sugestão como aceita assim mentiria: o
       chamado não mudou. */
    if (!aplicado || aplicado.length === 0) {
      return { error: 'Você não tem permissão para mudar a classificação deste chamado.' }
    }
  }

  const { data, error } = await supabase
    .from('ai_suggestions')
    .update({ status: decisao, acted_by: profile.id, acted_at: new Date().toISOString() })
    .eq('id', suggestion_id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/tickets/${ticket_id}`)
  return {
    success:
      decisao === 'recusada'
        ? 'Sugestão recusada. O registro fica — é como se mede se a IA ajuda.'
        : sugestao.kind === 'triagem'
          ? 'Classificação aplicada, com o seu nome no histórico do chamado.'
          : 'Sugestão marcada como usada.',
  }
}
