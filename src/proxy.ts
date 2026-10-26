import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { modoLocal } from '@/lib/db/modo'

/**
 * Renova a sessão do Supabase a cada navegação e barra acesso anônimo.
 *
 * `/tv/*` fica de fora de propósito: o painel de TV autentica por token de
 * exibição, não por sessão (ADR-006). Se exigíssemos login ali, o painel de
 * parede cairia na primeira expiração e ninguém perceberia por dias.
 */
/*
 * `/recuperar-senha` entra aqui porque quem esqueceu a senha, por definição, não
 * tem sessão. `/auth` é o retorno do link do e-mail, que troca o código por
 * sessão.
 *
 * `/nova-senha` NÃO entra: quem chega lá já passou por `/auth/confirmar` e tem a
 * sessão de recuperação. Deixá-la pública mostraria um formulário de troca de
 * senha a qualquer visitante — que não trocaria nada, mas convidaria a tentar.
 */
/*
 * `/avaliar` é público pelo mesmo motivo do painel de TV: quem responde a
 * pesquisa de satisfação é o solicitante, que muitas vezes NÃO tem conta — é o
 * funcionário da empresa-cliente que ligou para o suporte. Exigir login ali
 * derrubaria a taxa de resposta a quase zero, que é o mesmo que não ter a
 * pesquisa. O escopo vem do token do link, e a única porta é uma função
 * `security definer` que só aceita esse token e só devolve sucesso ou falha.
 *
 * `/api/jobs` NÃO entra: ele tem o próprio segredo (`JOBS_SECRET`), e deixá-lo
 * sob a guarda de sessão não atrapalha — o agendador não manda cookie, mas
 * também não é redirecionado, porque a rota responde 401 antes disso.
 *
 * `/api/agent` entra, e precisa entrar: quem chama é o agente de inventário
 * rodando como serviço em computador de cliente. Ele não tem navegador, não tem
 * cookie e não segue redirecionamento — se esta rota fosse guardada pela sessão,
 * a resposta seria um 307 para `/login` que o agente registraria como "servidor
 * respondeu algo estranho" e repetiria para sempre.
 *
 * O que autoriza ali é o token DA MÁQUINA, conferido por função `security
 * definer` no banco. É o mesmo desenho de `/avaliar`, e pelo mesmo motivo: quem
 * chama não é uma pessoa com conta.
 */
/*
 * `/api/canais` entra pelo mesmo motivo de `/api/agent`: quem chama é a Meta, o
 * Bitrix24 ou um fluxo do N8N. Nenhum deles tem navegador, cookie ou segue
 * redirecionamento — e a Meta DESINSCREVE um webhook que devolve erro
 * repetidamente, então um 307 para `/login` desligaria a integração por conta
 * própria.
 *
 * O que autoriza ali é o token do canal na URL, conferido por função `security
 * definer` no banco, mais a assinatura do provedor quando ele assina.
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/recuperar-senha',
  '/tv',
  '/avaliar',
  '/api/health',
  '/api/jobs',
  '/api/agent',
  '/api/canais',
  '/auth',
]

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  /*
   * Modo local: a sessão é um cookie assinado, e conferi-lo é verificar o HMAC
   * — não há token para revalidar contra um servidor de autenticação. O resto
   * da função (quem é público, para onde redirecionar) é idêntico, e é
   * deliberado que seja: a regra de acesso não pode depender do driver.
   */
  if (modoLocal()) {
    const { conferir, nomeDoCookie } = await import('@/lib/db/sessao')
    const conteudo = conferir(request.cookies.get(nomeDoCookie())?.value)
    return decidir(request, response, conteudo ? { id: conteudo.sub } : null)
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // getUser() revalida o token no servidor. getSession() apenas lê o cookie e
  // aceitaria um JWT forjado — a diferença importa em um middleware de acesso.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return decidir(request, response, user ? { id: user.id } : null)
}

/** A regra de acesso, igual nos dois modos. */
function decidir(
  request: NextRequest,
  response: NextResponse,
  user: { id: string } | null,
) {

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('proxima', pathname)
    return NextResponse.redirect(url)
  }

  if (user && (pathname === '/login' || pathname === '/recuperar-senha')) {
    const url = request.nextUrl.clone()
    url.pathname = '/painel'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
