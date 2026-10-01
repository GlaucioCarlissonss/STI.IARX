import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Converte o link do e-mail numa sessão de recuperação.
 *
 * O Supabase manda a pessoa para cá com um `code` de uso único; trocá-lo por
 * sessão é o que permite `updateUser({ password })` logo em seguida. Sem esta
 * troca, a tela de nova senha receberia alguém sem sessão e não teria como
 * saber de quem é a senha que está mudando.
 *
 * É uma rota de GET porque quem chega aqui é um clique em e-mail — não há
 * formulário para enviar. Ela não decide nada além de "deu certo ou não": a
 * autorização inteira é do Supabase, que valida o código, sua expiração e seu
 * uso único.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}/nova-senha`)
    }
  }

  /* Link expirado, já usado ou adulterado caem todos aqui, com a mesma
     mensagem: detalhar qual dos três foi só ajudaria quem está testando links
     alheios, e para quem perdeu o prazo a ação é a mesma — pedir outro. */
  return NextResponse.redirect(`${origin}/recuperar-senha?expirado=1`)
}
