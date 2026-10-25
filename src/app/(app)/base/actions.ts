'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { Route } from 'next'
import { z } from 'zod'
import { optionalUuid } from '@/lib/schemas/campos'
import { createClient } from '@/lib/supabase/server'
import { permitirEscrita } from '@/lib/actions/guarda'
import { requireSession } from '@/lib/session'
import { mensagemDeErro, NAO_AFETADO } from '@/lib/actions/erros'
import type { ActionState } from '@/lib/actions/estado'

const artigoSchema = z.object({
  id: optionalUuid,
  title: z.string().trim().min(3, 'O título precisa de pelo menos 3 caracteres.').max(200),
  resumo: z
    .string()
    .trim()
    .max(300, 'O resumo cabe em 300 caracteres — ele é uma linha.')
    .transform((v) => (v === '' ? null : v)),
  body: z.string().trim().min(10, 'O corpo está curto demais para ajudar alguém.'),
  category_id: optionalUuid,
  visibilidade: z.enum(['interno', 'solicitante']),
  publicar: z.coerce.boolean(),
  source_ticket_id: optionalUuid,
})

/**
 * Cria ou atualiza um artigo.
 *
 * ## Por que publicar é uma caixa de seleção, e não um botão separado
 *
 * Porque a decisão de publicar é tomada no mesmo instante em que o texto fica
 * pronto, e quase sempre pela mesma pessoa. Um botão "publicar" numa segunda
 * tela adiciona um passo que, na prática, não é dado: o artigo fica em rascunho
 * para sempre, e a base não serve a ninguém.
 *
 * O que NÃO é automático é a visibilidade: ela nasce `interno` e a pessoa precisa
 * marcar explicitamente para liberar ao solicitante. Um artigo com a senha do
 * roteador publicado por engano para o cliente é a falha que esta tela tem de
 * tornar difícil.
 */
export async function salvarArtigo(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('autoatendimento.base.escrever', {
    mensagem: 'Sem permissão para escrever na base de conhecimento.',
  })
  if ('error' in gate) return gate
  const { profile } = gate

  const parsed = artigoSchema.safeParse({
    id: formData.get('id'),
    title: formData.get('title'),
    resumo: formData.get('resumo') ?? '',
    body: formData.get('body'),
    category_id: formData.get('category_id'),
    visibilidade: formData.get('visibilidade') ?? 'interno',
    publicar: formData.get('publicar') === 'on',
    source_ticket_id: formData.get('source_ticket_id'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const { id, publicar, ...campos } = parsed.data
  const supabase = await createClient()

  const valores = {
    ...campos,
    status: publicar ? 'publicado' : 'rascunho',
    /* A data de publicação é obrigatória para o status `publicado` (CHECK na
       migração 0033): sem ela não dá para ordenar por "mais recente", que é a
       ordenação da lista. */
    published_at: publicar ? new Date().toISOString() : null,
  }

  if (id) {
    const { data, error } = await supabase
      .from('kb_articles')
      .update(valores)
      .eq('id', id)
      .select('id')
    if (error) return { error: mensagemDeErro(error) }
    if (!data || data.length === 0) return { error: NAO_AFETADO }
    revalidatePath(`/base/${id}`)
    revalidatePath('/base')
    return { success: publicar ? 'Artigo publicado.' : 'Rascunho salvo.' }
  }

  const { data, error } = await supabase
    .from('kb_articles')
    .insert({ ...valores, tenant_id: profile.tenant_id, author_id: profile.id })
    .select('id')
  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/base')
  redirect(`/base/${data[0]!.id}` as Route)
}

/**
 * Arquiva um artigo.
 *
 * Arquivar e não apagar: o artigo some da busca e continua existindo para quem
 * escreve. Uma resposta que deixou de valer ainda diz o que já se soube, e a
 * pergunta "por que isto mudou?" precisa da versão anterior para ser respondida.
 */
export async function arquivarArtigo(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const gate = await permitirEscrita('autoatendimento.base.escrever', {
    mensagem: 'Sem permissão para arquivar artigos.',
  })
  if ('error' in gate) return gate

  const id = formData.get('article_id')
  if (typeof id !== 'string' || id === '') return { error: 'Artigo inválido.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('kb_articles')
    .update({ status: 'arquivado' })
    .eq('id', id)
    .select('id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath('/base')
  return { success: 'Artigo arquivado. Ele sai da busca e continua disponível para edição.' }
}

const votoSchema = z.object({
  article_id: z.string().uuid(),
  util: z.enum(['sim', 'nao']),
  comentario: z.string().trim().max(1000).optional(),
})

/**
 * "Isto resolveu o seu problema?"
 *
 * É a única pergunta que a base precisa responder sobre si mesma. Sem ela, a
 * medida de qualidade dos artigos vira o número de leituras — que diz o que as
 * pessoas clicaram, não o que as ajudou.
 *
 * Não passa por `permitirEscrita`: votar não é escrever no artigo, e o público
 * principal da base é justamente quem NÃO tem permissão de escrita. A policy
 * `kb_feedback_own` é quem garante que cada um só mexe no próprio voto.
 */
export async function votarNoArtigo(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { profile } = await requireSession()

  const parsed = votoSchema.safeParse({
    article_id: formData.get('article_id'),
    util: formData.get('util'),
    comentario: formData.get('comentario') ?? undefined,
  })
  if (!parsed.success) return { error: 'Não consegui registrar a sua resposta.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('kb_feedback')
    .upsert(
      {
        tenant_id: profile.tenant_id,
        article_id: parsed.data.article_id,
        user_id: profile.id,
        util: parsed.data.util === 'sim',
        comentario: parsed.data.comentario ?? null,
      },
      /* `onConflict` explícito: sem ele o upsert tenta a chave primária inferida
         e falha quando a pessoa muda de ideia — que é justamente o caso em que
         mudar o voto importa. */
      { onConflict: 'article_id,user_id' },
    )
    .select('article_id')

  if (error) return { error: mensagemDeErro(error) }
  if (!data || data.length === 0) return { error: NAO_AFETADO }

  revalidatePath(`/base/${parsed.data.article_id}`)
  return {
    success:
      parsed.data.util === 'sim'
        ? 'Obrigado. Saber o que funciona é o que mantém a base útil.'
        : 'Obrigado — vamos revisar este artigo.',
  }
}
