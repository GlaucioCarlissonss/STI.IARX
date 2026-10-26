import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { modoLocal } from '@/lib/db/modo'

/**
 * Cliente Supabase para Server Components e Server Actions.
 *
 * Usa o JWT do usuário logado, portanto TODA consulta passa pelo RLS — é essa
 * a garantia de isolamento entre tenants (ADR-002). Nenhum código de aplicação
 * deve filtrar `tenant_id` manualmente: se a policy falhar, o dado não aparece,
 * em vez de aparecer por acidente.
 */
/*
 * O tipo do cliente sai desta função, e não de `ReturnType<typeof
 * createServerClient>`: aquele instancia os genéricos pelos limites, e o
 * resultado perde a tipagem de `.maybeSingle<T>()` em 564 pontos do app.
 */
/* eslint-disable-next-line @typescript-eslint/no-unused-vars -- existe para
   extrair o TIPO do cliente; chamá-la seria duplicar a construção. */
function clienteDeSessao(
  cookies: Parameters<typeof createServerClient>[2]['cookies'],
) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies },
  )
}

export type ClienteDeDados = ReturnType<typeof clienteDeSessao>

export async function createClient(): Promise<ClienteDeDados> {
  const cookieStore = await cookies()

  /*
   * Modo local: o app fala com um PostgreSQL direto, sem Supabase.
   *
   * A troca acontece aqui, e só aqui, porque todo acesso a dado do app passa
   * por esta função. O cliente devolvido tem a MESMA forma — e, mais
   * importante, o mesmo comportamento de RLS: cada consulta roda com
   * `set local role` e `set local request.jwt.claims`, que é o que o PostgREST
   * faz. Ver `lib/db/conexao.ts` e docs/22.
   */
  if (modoLocal()) {
    const { criarClienteLocal } = await import('@/lib/db/cliente')
    const { sessaoDoUsuario } = await import('@/lib/db/sessao')
    const { conferir, nomeDoCookie, novoConteudo, assinar, OPCOES_DO_COOKIE } = await import(
      '@/lib/db/sessao'
    )
    const { SESSAO_ANONIMA } = await import('@/lib/db/conexao')

    return criarClienteLocal({
      async obter() {
        const conteudo = conferir(cookieStore.get(nomeDoCookie())?.value)
        if (!conteudo) return SESSAO_ANONIMA
        return (await sessaoDoUsuario(conteudo.sub)) ?? SESSAO_ANONIMA
      },
      async entrar(sub) {
        cookieStore.set(nomeDoCookie(), assinar(novoConteudo(sub)), OPCOES_DO_COOKIE)
      },
      async sair() {
        cookieStore.delete(nomeDoCookie())
      },
    }) as unknown as ClienteDeDados
  }

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Components não podem gravar cookies. O middleware já cuida
            // da renovação da sessão, então ignorar aqui é seguro.
          }
        },
      },
    },
  )
}
