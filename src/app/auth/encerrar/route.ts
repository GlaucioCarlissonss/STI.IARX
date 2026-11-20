import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Encerra a sessão e devolve para a entrada.
 *
 * ## Por que isto existe, e por que é uma ROTA e não uma página
 *
 * Quando alguém é desativado **enquanto está dentro**, o cookie que ele tem na
 * mão continua válido para o proxy — que só confere a assinatura, não o estado
 * da conta no banco. A sessão da aplicação, essa sim, passou a recusar conta
 * inativa.
 *
 * O resultado foi um laço de redirecionamento, e eu o produzi antes de notar:
 *
 *     /tickets  → sem sessão → /login
 *     /login    → o proxy vê o cookie válido → /painel
 *     /painel   → sem sessão → /login  → …
 *
 * O navegador para sozinho em `ERR_TOO_MANY_REDIRECTS`, que é uma tela de erro
 * do navegador — nada que a aplicação escreveu, nada que explique o que houve.
 *
 * A causa não é o laço: é o **cookie que sobreviveu**. Enquanto ele existir, o
 * proxy vai insistir que há sessão. Apagá-lo é o conserto, e só quem pode
 * escrever cabeçalho de resposta apaga cookie — uma página renderizada no
 * servidor não pode. Daí a rota.
 *
 * ## É GET, e isso é deliberado apesar de alterar estado
 *
 * Encerrar sessão por GET normalmente é erro: qualquer `<img src>` de outro site
 * desconectaria a pessoa. Aqui o caminho é um redirecionamento interno de quem
 * já perdeu o acesso — o "estado" que ele altera é um cookie que acabou de
 * deixar de valer. O botão de sair continua sendo POST (`signOut`), que é onde
 * o risco de CSRF seria real.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  await supabase.auth.signOut()

  const pedido = request.nextUrl.searchParams.get('motivo')

  /*
   * O motivo vem de quem redirecionou, e passa por uma LISTA FECHADA.
   *
   * Ele é refletido na tela seguinte, e refletir parâmetro de URL sem filtrar é
   * como se faz um redirecionador de conteúdo: bastaria alguém mandar um link
   * com `?motivo=<qualquer coisa>` para escolher o que a vítima lê na tela de
   * entrada do sistema. A lista fechada custa uma linha.
   *
   * `inativa` é o padrão porque era o único motivo que existia quando esta rota
   * nasceu — um link antigo continua dizendo o que dizia.
   */
  const MOTIVOS = ['inativa', 'sem-perfil', 'sem-sessao']
  const motivo = pedido && MOTIVOS.includes(pedido) ? pedido : 'inativa'

  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  /* O motivo viaja na URL para a tela de entrada poder explicar. Sem ele, a
     pessoa seria devolvida a um formulário em branco, sem nenhuma pista de por
     que foi expulsa do meio do trabalho. */
  url.searchParams.set('motivo', motivo)

  return NextResponse.redirect(url)
}
