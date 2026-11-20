import { cache } from 'react'
import { AVISO_DE_INDISPONIBILIDADE, ehFalhaDeInfraestrutura } from '@/lib/infraestrutura'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Profile, Tenant, UserRole } from '@/lib/types'
import { PERMISSION_CATALOG, ROLE_RANK, can } from '@/lib/permissions'
import { landingHref } from '@/lib/navigation'
import { ESFERAS, lerEsferas, type Esfera } from '@/lib/esferas'

export interface SessionContext {
  userId: string
  profile: Profile
  tenant: Tenant | null
  /**
   * Chaves concedidas ao perfil de acesso da pessoa.
   *
   * Carregado junto do perfil, dentro do mesmo `cache()`: a matriz é lida uma
   * vez por requisição, não uma vez por botão.
   */
  permissions: ReadonlySet<string>
  /**
   * Esferas de negócio desta empresa.
   *
   * Sessão sem tenant é a da operação da plataforma (`super_admin`), e para ela
   * valem as duas: quem opera o SaaS precisa enxergar os dois negócios que o
   * SaaS atende.
   */
  esferas: Esfera[]
}

/**
 * Contexto da sessão, memoizado por requisição.
 *
 * `cache()` garante uma única ida ao banco mesmo quando vários Server
 * Components pedem o perfil na mesma renderização — sem isso, o layout e cada
 * página fariam a consulta separadamente.
 */
/**
 * POR QUE A SESSÃO DEIXOU DE SER RESOLVIDA, quando ela não foi.
 *
 * Isto existe porque `null` cobria três situações muito diferentes — sem
 * cookie, perfil não lido e conta inativa — e quem recebia o `null` traduzia as
 * três para a última. Com o banco parado, o sistema dizia a quem entrava que
 * **a conta dele estava desativada**: diagnóstico errado, e um conselho que
 * manda procurar quem não pode ajudar.
 *
 * Falha de infraestrutura não entra aqui: ela é LANÇADA (ver abaixo), porque
 * não é motivo para encerrar a sessão de ninguém.
 */
export type MotivoDaRecusa = 'sem-sessao' | 'sem-perfil' | 'inativa'

type Resolucao =
  | { ok: true; ctx: SessionContext }
  | { ok: false; motivo: MotivoDaRecusa }

const resolverSessao = cache(async (): Promise<Resolucao> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { ok: false, motivo: 'sem-sessao' }

  const { data: profile, error: erroDoPerfil } = await supabase
    .from('profiles')
    .select(
      'id, tenant_id, role, full_name, email, phone, is_active, last_seen_at, access_profile_id, focused_client_id',
    )
    .eq('id', user.id)
    .maybeSingle<Profile>()

  /*
   * LER O PERFIL FALHOU — e isso não diz nada sobre a conta.
   *
   * Antes, o erro era descartado (`const { data: profile }`) e o `null`
   * resultante virava "conta desativada". Banco parado, rede caída e pool
   * esgotado passavam todos por "procure o administrador da sua empresa".
   *
   * Lançar, e não devolver `null`, é deliberado por dois motivos:
   *
   *  · a sessão SOBREVIVE. Encerrar o acesso de quem está trabalhando por causa
   *    de uma queda de banco é punir a pessoa por um problema que não é dela —
   *    e, quando o banco voltar, ela teria de entrar de novo sem motivo;
   *  · a falha aparece na fronteira de erro, que diz "tente de novo; se
   *    continuar, avise o suporte" e registra o `digest` que casa com o log.
   *
   * O `digest` é o que liga esta tela ao `ECONNREFUSED` do servidor. Sem ele, a
   * pessoa vê um texto genérico e quem opera vê uma linha de log, e ninguém
   * junta as duas.
   */
  if (erroDoPerfil) {
    if (ehFalhaDeInfraestrutura(erroDoPerfil)) {
      console.error('[sessão] banco indisponível ao ler o perfil:', erroDoPerfil)
      throw new Error(AVISO_DE_INDISPONIBILIDADE, { cause: erroDoPerfil })
    }
    /* Erro que NÃO é de conexão — RLS, coluna que sumiu numa migração pela
       metade. Também não é "conta desativada", e também não pode ser engolido:
       um perfil ilegível por defeito de esquema precisa aparecer como defeito. */
    console.error('[sessão] falha ao ler o perfil:', erroDoPerfil)
    throw new Error('Não foi possível ler o seu perfil.', { cause: erroDoPerfil })
  }

  /* Sem erro e sem linha: a conta existe na autenticação e não tem perfil nesta
     instalação. É problema de conta de verdade — e um problema diferente de
     "desativada", porque reativar não resolve: falta criar o vínculo. */
  if (!profile) return { ok: false, motivo: 'sem-perfil' }

  /*
   * A SEGUNDA TRANCA: conta desativada não tem sessão.
   *
   * O login já recusa (`src/app/login/actions.ts`), e essa é a tranca que dá
   * mensagem útil. Esta aqui é a que vale para quem **já estava dentro** quando
   * foi desativado: sem ela, a pessoa continuaria navegando com o cookie que
   * tem na mão até ele vencer — e desativar alguém num incidente é exatamente o
   * momento em que isso não pode acontecer.
   *
   * Devolver `null` é o mesmo que "não há sessão": o proxy manda para o login,
   * e lá a mensagem explica.
   */
  if (!profile.is_active) return { ok: false, motivo: 'inativa' }

  const [{ data: tenant }, { data: grants }] = await Promise.all([
    profile.tenant_id
      ? supabase
          .from('tenants')
          .select(
            'id, name, slug, sla_warning_pct, sla_critical_pct, auto_close_after_days, spheres',
          )
          .eq('id', profile.tenant_id)
          .maybeSingle<Tenant>()
      : Promise.resolve({ data: null }),
    profile.access_profile_id
      ? supabase
          .from('permission_grants')
          .select('permission_key')
          .eq('profile_id', profile.access_profile_id)
      : Promise.resolve({ data: null }),
  ])

  return {
    ok: true,
    ctx: {
      userId: user.id,
      profile,
      tenant,
      esferas: tenant ? lerEsferas(tenant.spheres) : [...ESFERAS],
      permissions: grants
        ? new Set(grants.map((g) => g.permission_key))
        : permissionsFromRole(profile.role),
    },
  }
})

/**
 * Contexto da sessão, ou `null` quando não há.
 *
 * A assinatura é a de sempre: as dezenas de chamadas que só perguntam "tem
 * sessão?" continuam valendo. Quem precisa saber POR QUE não há usa
 * `requireSession()`, que redireciona com o motivo certo.
 */
export const getSessionContext = async (): Promise<SessionContext | null> => {
  const r = await resolverSessao()
  return r.ok ? r.ctx : null
}

/**
 * Conjunto de permissões derivado apenas do papel.
 *
 * Rede de segurança para quem não tem perfil de acesso atribuído — o
 * `super_admin`, que é papel da operação da plataforma, e qualquer linha que
 * escape das triggers de provisionamento. Concede tudo que o papel alcança, que
 * é exatamente o comportamento anterior aos perfis: sem isso, um `super_admin`
 * logaria e não veria tela nenhuma.
 */
function permissionsFromRole(role: UserRole): ReadonlySet<string> {
  const rank = ROLE_RANK[role]
  return new Set(
    PERMISSION_CATALOG.filter((p) => ROLE_RANK[p.minBaseRole] <= rank).map((p) => p.key),
  )
}

/** Igual ao anterior, mas redireciona para o login em vez de devolver null. */
export async function requireSession(): Promise<SessionContext> {
  const r = await resolverSessao()
  if (!r.ok) {
    /*
     * `/auth/encerrar` e não `/login`, e a diferença não é estilo.
     *
     * Quem chega aqui pode estar nos dois casos: sem cookie nenhum (e aí o
     * proxy já teria mandado para o login antes), ou **com cookie válido e
     * conta desativada**. No segundo, mandar para `/login` produz laço: o proxy
     * vê o cookie, acredita que há sessão e devolve para `/painel`, que cai
     * aqui de novo. Foi o que aconteceu ao escrever esta guarda, e o navegador
     * terminou em ERR_TOO_MANY_REDIRECTS — uma tela de erro que não explica
     * nada.
     *
     * A rota apaga o cookie antes de devolver à entrada. Sem cookie, o proxy
     * deixa a tela de login aparecer, e ela diz o que houve.
     */
    redirect(`/auth/encerrar?motivo=${r.motivo}`)
  }
  return r.ctx
}

/**
 * Gate de TELA: exige a permissão de consulta e devolve o contexto.
 *
 * Redireciona em vez de mostrar 403 porque a pessoa chegou aqui pelo menu ou por
 * um link antigo — mandá-la para o painel é mais útil que uma parede.
 */
export async function requireScreen(viewPermission: string): Promise<SessionContext> {
  const ctx = await requireSession()
  /*
   * O destino é a primeira tela que ESTA sessão alcança, nunca `/painel` fixo.
   * Com destino fixo havia laço: os perfis financeiros do sistema não recebem o
   * módulo de helpdesk, então `/painel` negava e redirecionava para `/painel`.
   * `landingHref()` só devolve href permitido, e cai em `/conta` — que não exige
   * permissão de módulo — quando a sessão não alcança tela nenhuma.
   */
  if (!can(ctx.permissions, viewPermission)) redirect(landingHref(ctx.permissions))
  return ctx
}

/**
 * Gate de AÇÃO, para o topo de cada Server Action.
 *
 * Devolve `{ error }` em vez de redirecionar: a ação responde a um formulário, e
 * um redirect no meio de um `useActionState` engoliria a mensagem. O texto é
 * deliberadamente igual ao de "registro não encontrado" das ações de escrita —
 * quem não tem permissão não deve conseguir distinguir "não pode" de "não
 * existe", que é como se enumera o que existe do outro lado.
 */
export async function requirePermission(
  permission: string,
): Promise<{ ctx: SessionContext } | { error: string }> {
  const ctx = await requireSession()
  if (!can(ctx.permissions, permission)) {
    return { error: 'Sem permissão para esta ação.' }
  }
  return { ctx }
}

/** Açúcar para componentes de servidor: `if (await allowed('...'))`. */
export async function allowed(permission: string): Promise<boolean> {
  const ctx = await getSessionContext()
  return ctx ? can(ctx.permissions, permission) : false
}

export function canManageConfig(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin'
}

export function canManageRecords(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'gestor'
}

export function canWorkTickets(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'gestor' || role === 'atendente'
}

/**
 * Marca presença do atendente. Alimenta o contador "atendentes online" do
 * painel de TV (RF-DSH-02) sem exigir um canal de presença dedicado: a própria
 * navegação no sistema já é o sinal de que a pessoa está trabalhando.
 */
export async function touchPresence(userId: string): Promise<void> {
  const supabase = await createClient()
  await supabase.from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', userId)
}
