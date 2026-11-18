'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { modoLocal } from '@/lib/db/modo'
import { ipDoCliente, origemHasheada, permitirRequisicao } from '@/lib/limite'

/**
 * Criar conta: uma empresa nova, em avaliação.
 *
 * ## Esta é a primeira porta que escreve no banco sem ninguém autenticado
 *
 * Por isso ela só veio depois das defesas, e não junto: freio por origem
 * (0059), token de uso único (0057), caixa de saída com tela (0058) e conta
 * inativa que de fato não entra — este último era um defeito, corrigido antes
 * de existir cadastro que dependesse dele.
 *
 * ## A resposta é SEMPRE a mesma
 *
 * E-mail novo, e-mail que já tem conta, limite estourado, cadastro fechado: a
 * tela responde a mesma frase. Qualquer diferença visível transformaria este
 * formulário num verificador de contas — exatamente o que a tela de redefinição
 * de senha evita com cuidado, e não adianta fechar uma porta e deixar a outra
 * aberta no mesmo prédio.
 *
 * Quem é dono do endereço descobre o que houve **pelo e-mail**, que é o único
 * canal onde a diferença pode aparecer sem informar estranho nenhum.
 */

const cadastroSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o seu nome.').max(120),
  empresa: z.string().trim().min(2, 'Informe o nome da empresa.').max(120),
  email: z.string().trim().toLowerCase().email('Informe um e-mail válido.'),
  /*
   * Doze, e não oito como a troca de senha.
   *
   * Esta é a senha do ADMINISTRADOR de uma empresa inteira, escolhida por quem
   * ainda não conhece o produto e está com pressa para entrar. É o pior momento
   * para aceitar uma senha curta, e o único em que dá para exigir melhor sem
   * atrapalhar quem já trabalha.
   */
  senha: z.string().min(12, 'A senha precisa de pelo menos 12 caracteres.').max(200),
  esferas: z.enum(['management', 'rental', 'ambas']).default('management'),
})

export interface CadastroState {
  error?: string
  enviado?: boolean
}

/** A mesma resposta para todos os desfechos — ver o cabeçalho. */
const RESPOSTA_UNICA: CadastroState = { enviado: true }

export async function criarConta(
  _prev: CadastroState,
  formData: FormData,
): Promise<CadastroState> {
  const parsed = cadastroSchema.safeParse({
    nome: formData.get('nome'),
    empresa: formData.get('empresa'),
    email: formData.get('email'),
    senha: formData.get('senha'),
    esferas: formData.get('esferas') ?? 'management',
  })

  /*
   * Erro de FORMATO aparece na tela, e isso não contradiz a regra acima: "a
   * senha é curta" e "o e-mail não tem arroba" falam do que a pessoa acabou de
   * digitar, não do que existe no banco. Esconder isso faria o formulário
   * recusar em silêncio e ninguém entenderia por quê.
   */
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  if (!modoLocal()) {
    /* No Supabase quem cria conta é o GoTrue, com fluxo próprio de confirmação.
       Atender pela metade aqui criaria empresa sem usuário utilizável. */
    return { error: 'O cadastro público não está disponível neste ambiente.' }
  }

  const admin = createAdminClient()

  const cabecalhos = await headers()
  const origem = origemHasheada(
    ipDoCliente({
      xForwardedFor: cabecalhos.get('x-forwarded-for'),
      xRealIp: cabecalhos.get('x-real-ip'),
    }),
  )

  if (!(await permitirRequisicao(admin, 'signup', origem))) {
    return RESPOSTA_UNICA
  }

  const { nome, empresa, email, senha, esferas } = parsed.data

  /*
   * E-mail já cadastrado: a tela responde igual, e o AVISO VAI POR E-MAIL.
   *
   * Dizer "este e-mail já está em uso" resolveria para quem errou e entregaria
   * um verificador de contas a qualquer um. Silêncio total não vaza nada e
   * abandona quem simplesmente esqueceu que já tinha conta — e essa pessoa vai
   * tentar de novo, e de novo.
   *
   * O aviso não leva link de redefinição: mandar caminho de troca de senha a
   * quem não pediu transformaria esta mensagem na ferramenta que ela deveria
   * impedir.
   */
  const { data: existe } = await admin
    .from('profiles')
    .select('id')
    .ilike('email', email)
    .maybeSingle<{ id: string }>()

  if (existe) {
    const { error } = await admin.schema('app').rpc('avisar_conta_existente', { p_email: email })
    if (error) console.error('[criar-conta] aviso de conta existente:', error.message)
    return RESPOSTA_UNICA
  }

  const { error: erroDaCriacao } = await admin
    .schema('app')
    .rpc('criar_empresa_em_avaliacao', {
      p_email: email,
      p_nome: nome,
      p_empresa: empresa,
      p_senha: senha,
      p_esferas: esferas === 'ambas' ? ['management', 'rental'] : [esferas],
    })

  if (erroDaCriacao) {
    /*
     * Vai para o log, não para a tela. Inclui o caso em que duas tentativas
     * simultâneas passaram pela verificação acima e a última tranca do banco
     * recusou a segunda — do lado de fora isso tem de parecer igual a tudo o
     * mais.
     */
    console.error('[criar-conta] falha ao criar:', erroDaCriacao.message)
    return RESPOSTA_UNICA
  }

  const { error: erroDoToken } = await admin.schema('app').rpc('emitir_token_de_acesso', {
    p_email: email,
    p_purpose: 'email_confirm',
    /* 48 horas, e não uma: quem se cadastra às seis da tarde abre o e-mail no
       dia seguinte, e um link vencido no primeiro contato com o produto é a
       pior primeira impressão possível. */
    p_minutos: 60 * 48,
  })

  if (erroDoToken) {
    console.error('[criar-conta] falha ao emitir confirmação:', erroDoToken.message)
  }

  return RESPOSTA_UNICA
}
