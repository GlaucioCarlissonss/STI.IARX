import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import { executarComoDono, type Sessao } from './conexao'

/**
 * A sessão do modo local: um cookie assinado, e nada mais.
 *
 * ## Por que não um JWT de verdade
 *
 * Porque ninguém o verificaria. No Supabase o JWT é assinado pelo GoTrue e
 * conferido pelo PostgREST — são dois processos, e a assinatura é o que os liga.
 * Aqui só existe um processo: quem emite o cookie é quem o lê. Um JWT seria a
 * mesma coisa com mais cerimônia e mais superfície para errar.
 *
 * O que **não** muda: os claims que saem daqui vão inteiros para
 * `request.jwt.claims`, e é o banco que decide o que a pessoa vê. O cookie diz
 * QUEM é; o RLS diz O QUE ela pode.
 *
 * ## tenant_id em app_metadata, nunca em user_metadata
 *
 * A regra do ADR-002 vale igual aqui, e pelo mesmo motivo: no Supabase,
 * `user_metadata` é gravável pelo próprio usuário via `updateUser()`. Guardar
 * o tenant ali deixaria qualquer pessoa trocar de empresa. Em modo local
 * `updateUser()` nem toca nesses campos — mas manter a mesma forma é o que faz
 * o código do app não precisar saber em qual modo está rodando.
 */

const COOKIE = 'sti_sessao'
const DURACAO_SEGUNDOS = 60 * 60 * 8

function segredo(): string {
  const valor = process.env.LOCAL_AUTH_SECRET
  if (valor && valor.length >= 16) return valor
  /*
   * Em desenvolvimento, um segredo efêmero por processo é melhor que um fixo
   * escrito no código: reiniciar o servidor derruba as sessões, o que é
   * inconveniente e honesto. Um segredo padrão no repositório seria uma chave
   * pública para assinar sessões de qualquer instalação.
   */
  if (!processoSegredo) processoSegredo = randomBytes(32).toString('hex')
  return processoSegredo
}
let processoSegredo: string | null = null

export interface ConteudoDoCookie {
  sub: string
  exp: number
}

export function nomeDoCookie(): string {
  return COOKIE
}

export function assinar(conteudo: ConteudoDoCookie): string {
  const corpo = Buffer.from(JSON.stringify(conteudo)).toString('base64url')
  const assinatura = createHmac('sha256', segredo()).update(corpo).digest('base64url')
  return `${corpo}.${assinatura}`
}

export function conferir(valor: string | undefined): ConteudoDoCookie | null {
  if (!valor) return null
  const [corpo, assinatura] = valor.split('.')
  if (!corpo || !assinatura) return null

  const esperada = createHmac('sha256', segredo()).update(corpo).digest('base64url')
  const a = Buffer.from(assinatura)
  const b = Buffer.from(esperada)
  /* Comparação de tempo constante: comparar com `===` entrega, pelo tempo de
     resposta, quantos bytes da assinatura estavam certos. */
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const conteudo = JSON.parse(Buffer.from(corpo, 'base64url').toString()) as ConteudoDoCookie
    if (!conteudo.sub || typeof conteudo.exp !== 'number') return null
    if (conteudo.exp < Math.floor(Date.now() / 1000)) return null
    return conteudo
  } catch {
    return null
  }
}

export function novoConteudo(sub: string): ConteudoDoCookie {
  return { sub, exp: Math.floor(Date.now() / 1000) + DURACAO_SEGUNDOS }
}

export const OPCOES_DO_COOKIE = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: DURACAO_SEGUNDOS,
  secure: process.env.NODE_ENV === 'production',
}

/**
 * Monta os claims a partir do banco, e não do cookie.
 *
 * O cookie carrega só o `sub`. Papel e tenant são lidos de `auth.users` a cada
 * requisição — que é mais caro e é o certo: um usuário desativado ou movido de
 * empresa passa a valer na requisição seguinte, e não quando o cookie expirar
 * daqui a oito horas.
 */
export async function sessaoDoUsuario(sub: string): Promise<Sessao | null> {
  const linhas = await executarComoDono(
    `select id, email, raw_app_meta_data from auth.users where id = $1`,
    [sub],
  )
  const usuario = linhas[0]
  if (!usuario) return null

  const meta = (usuario['raw_app_meta_data'] ?? {}) as Record<string, unknown>
  return {
    userId: String(usuario['id']),
    papel: 'authenticated',
    claims: {
      sub: String(usuario['id']),
      email: usuario['email'],
      role: 'authenticated',
      app_metadata: meta,
    },
  }
}

/**
 * Confere e-mail e senha.
 *
 * A comparação acontece no banco, com `crypt()` do pgcrypto: a senha em claro
 * nunca é comparada em JavaScript, e o hash nunca sai do banco. É o mesmo
 * desenho do GoTrue, com uma extensão a menos no caminho.
 */
export async function autenticar(email: string, senha: string): Promise<string | null> {
  const linhas = await executarComoDono(
    `select id from auth.users
      where lower(email) = lower($1)
        and encrypted_password is not null
        and encrypted_password = crypt($2, encrypted_password)`,
    [email, senha],
  )
  return linhas[0] ? String(linhas[0]['id']) : null
}

export async function trocarSenha(sub: string, senha: string): Promise<void> {
  await executarComoDono(
    `update auth.users set encrypted_password = crypt($2, gen_salt('bf')) where id = $1`,
    [sub, senha],
  )
}
