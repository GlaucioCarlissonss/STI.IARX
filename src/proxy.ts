import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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
const PUBLIC_PREFIXES = ['/login', '/recuperar-senha', '/tv', '/api/health', '/auth']

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

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
