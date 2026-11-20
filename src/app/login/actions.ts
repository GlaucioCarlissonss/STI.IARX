'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { Route } from 'next'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import {
  AVISO_DE_INDISPONIBILIDADE,
  CODIGO_INDISPONIVEL,
  ehFalhaDeInfraestrutura,
} from '@/lib/infraestrutura'

const credentialsSchema = z.object({
  email: z.string().email('Informe um e-mail válido.'),
  password: z.string().min(1, 'Informe a senha.'),
})

export interface AuthFormState {
  error?: string
  /* Código estável, para a interface ramificar sem depender da frase. Prosa
     melhora com o tempo; condicional escrita sobre prosa quebra junto. */
  codigo?: string
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()

  /*
   * O `try` existe porque `autenticar()` LANÇA quando a conexão falha. Sem ele,
   * a exceção subia da Server Action e quem estava na tela recebia o erro
   * genérico — honesto, e que não diz nem que a senha está certa nem a quem
   * avisar. Com o banco fora, a pessoa desconfia da própria senha.
   *
   * O `if` abaixo cobre o outro formato: quando a falha de conexão chega como
   * `{ error }` em vez de exceção, ela cairia no `return` seguinte e a tela
   * diria "E-mail ou senha incorretos" — uma frase falsa que é também um
   * conselho errado, porque manda tentar outra senha e pedir redefinição.
   *
   * `autenticar()` LANÇA quando a conexão falha, em vez de devolver `{ error }`
   * — e sem este `try` a exceção subia da Server Action, o que também não
   * explicava nada a quem estava na tela.
   */
  let erroDoLogin: { code?: string; message: string } | null = null
  try {
    const { error } = await supabase.auth.signInWithPassword(parsed.data)
    erroDoLogin = error
  } catch (e) {
    if (ehFalhaDeInfraestrutura(e)) {
      console.error('[login] banco indisponível:', e)
      return { error: AVISO_DE_INDISPONIBILIDADE, codigo: CODIGO_INDISPONIVEL }
    }
    throw e
  }

  if (erroDoLogin) {
    /* O driver pode devolver a falha de conexão como objeto em vez de lançá-la,
       dependendo de onde ela aconteceu. O mesmo tratamento vale, pelo mesmo
       motivo. */
    if (ehFalhaDeInfraestrutura(erroDoLogin)) {
      console.error('[login] banco indisponível:', erroDoLogin)
      return { error: AVISO_DE_INDISPONIBILIDADE, codigo: CODIGO_INDISPONIVEL }
    }
    // Mensagem genérica de propósito: distinguir "e-mail não existe" de "senha
    // errada" entrega ao atacante uma forma de enumerar contas válidas.
    return { error: 'E-mail ou senha incorretos.' }
  }

  /*
   * CONTA DESATIVADA NÃO ENTRA — e até aqui entrava.
   *
   * A tela de usuários oferece inativar alguém desde que existe, e `is_active`
   * era lido em `getSessionContext` e nunca aplicado: quem fosse desativado
   * continuava entrando e usando o sistema normalmente. Medi antes de afirmar —
   * desativei uma conta do exemplo e ela chegou ao painel.
   *
   * É a diferença entre "tirei o acesso dessa pessoa" e "mudei um campo que não
   * faz nada", e quem desativa acredita na primeira.
   *
   * A mensagem aqui é específica, e isso é seguro: neste ponto a senha JÁ foi
   * conferida. Quem chegou aqui provou ser o dono da conta, então dizer-lhe que
   * ela está desativada não informa estranho nenhum — e a alternativa,
   * "e-mail ou senha incorretos", mandaria a pessoa tentar de novo para sempre.
   */
  const { data: { user: usuario } } = await supabase.auth.getUser()

  const { data: perfil } = await supabase
    .from('profiles')
    .select('is_active')
    .eq('id', usuario?.id ?? '')
    .maybeSingle<{ is_active: boolean }>()

  if (perfil && !perfil.is_active) {
    /*
     * Dois motivos, o mesmo campo, conselhos OPOSTOS.
     *
     * Quem acabou de se cadastrar e ainda não clicou no link precisa ouvir
     * "abra o seu e-mail". Mandá-lo procurar o administrador o tranca no
     * primeiro minuto de uso, atrás de um administrador que é ele mesmo.
     *
     * A diferença está nos fatos — conta não confirmada tem token de
     * confirmação vivo —, e não num campo novo que diria o mesmo.
     */
    const { data: aguardando } = await supabase.rpc('conta_aguarda_confirmacao', {
      p_user: usuario?.id ?? '',
    })

    await supabase.auth.signOut()

    return {
      error: aguardando
        ? 'Confirme o seu e-mail para ativar a conta. O link foi enviado no cadastro e vale por 48 horas.'
        : 'Esta conta está desativada. Procure o administrador da sua empresa para reativá-la.',
    }
  }

  // Só aceitamos caminho relativo iniciado por "/" e sem "//": um destino como
  // "//site-malicioso.com" seria tratado pelo navegador como URL absoluta,
  // transformando o login em um redirecionador aberto.
  const next = formData.get('proxima')
  const isSafeInternalPath =
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')

  revalidatePath('/', 'layout')
  redirect(isSafeInternalPath ? (next as Route) : '/painel')
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
  redirect('/login')
}
