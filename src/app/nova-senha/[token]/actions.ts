'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { trocarSenha } from '@/lib/db/sessao'
import { modoLocal } from '@/lib/db/modo'
import { newPasswordSchema } from '@/lib/schemas/auth'
import type { ActionState } from '@/lib/actions/estado'

/**
 * Grava a senha nova de quem chegou pelo link, no modo local.
 *
 * ## Por que é uma ação separada da de `/nova-senha`
 *
 * Aquela exige **sessão** — a de recuperação, que o Supabase cria em
 * `/auth/confirmar`. Esta não tem sessão nenhuma para exigir: no modo local não
 * há GoTrue, e quem chega aqui chega anônimo, com um token na URL. São dois
 * mecanismos de autorização diferentes, e espremê-los numa função só produziria
 * uma com dois caminhos onde o errado abriria a porta sem token.
 *
 * ## A ordem importa: gasta o token ANTES de trocar a senha
 *
 * `consumir_token_de_acesso` marca o token como usado e devolve de quem ele é,
 * no mesmo `update` — é o que impede dois cliques simultâneos de valerem os
 * dois. Só depois a senha é escrita.
 *
 * Se a escrita da senha falhar depois disso, o token já morreu e a pessoa
 * precisa pedir outro link. É o lado seguro de falhar: o contrário — trocar a
 * senha e só então gastar o token — deixaria uma janela em que o mesmo link
 * troca a senha duas vezes, e a segunda troca seria de quem interceptou o
 * e-mail, não de quem pediu.
 */
export async function definirSenhaComToken(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!modoLocal()) {
    /* Esta rota não existe no modo Supabase: lá o caminho é `/auth/confirmar`,
       que cria sessão de recuperação. Recusar é melhor que atender pela metade. */
    return { error: 'Este caminho de redefinição não está disponível neste ambiente.' }
  }

  const token = String(formData.get('token') ?? '')
  if (!token) return { error: 'O link está incompleto. Peça um novo e-mail de redefinição.' }

  const parsed = newPasswordSchema.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const admin = createAdminClient()
  const { data: userId, error } = await admin.rpc('consumir_token_de_acesso', {
    p_token: token,
    p_purpose: 'password_reset',
  })

  if (error) {
    console.error('[nova-senha] falha ao consumir token:', error.message)
    return { error: 'Não foi possível concluir agora. Tente novamente em alguns minutos.' }
  }

  /*
   * Uma mensagem só para "expirou", "já foi usado" e "não existe".
   *
   * Distinguir ajudaria quem está tentando adivinhar token muito mais do que
   * ajuda quem perdeu o prazo — e para este a instrução útil é a mesma nos três
   * casos: peça outro link.
   */
  if (!userId) {
    return { error: 'Este link não vale mais. Peça um novo e-mail de redefinição.' }
  }

  await trocarSenha(String(userId), parsed.data.password)

  /*
   * NÃO entra sozinho — e aqui a decisão é o contrário da tela irmã.
   *
   * Lá, a sessão de recuperação já existe e mandar ao login faria a pessoa
   * digitar agora a senha que acabou de escolher. Aqui não há sessão: criar uma
   * a partir de um token que chegou por e-mail transformaria "quem leu o e-mail"
   * em "quem está logado", sem nunca provar que sabe a senha. Digitar uma vez é
   * barato, e é a prova.
   */
  return { success: 'Senha alterada. Entre com a senha nova.' }
}
