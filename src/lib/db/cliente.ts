import { Consulta, type Esquema, type LinhaQualquer } from './consulta'
import { carregarRelacoes, carregarTiposDeColuna } from './relacoes'
import { executarNaSessao, obterPool, SESSAO_ANONIMA, type Sessao } from './conexao'
import { assinarCaminho, gravar, remover } from './armazenamento'
import { autenticar, sessaoDoUsuario, trocarSenha } from './sessao'
import { SIGNED_URL_TTL } from '@/lib/storage'

/**
 * O cliente local, com a forma do cliente Supabase.
 *
 * O app não sabe qual dos dois está usando — e é esse o ponto. Trocar o driver
 * é trocar a fábrica em `lib/supabase/*`, e nenhuma das 333 chamadas de
 * `.select()` muda.
 *
 * ## O que está aqui, e o que não está
 *
 * Está: consulta, escrita, RPC, autenticação por senha, armazenamento de
 * arquivo com URL assinada.
 *
 * Não está: tempo real. O canal existe e não entrega evento nenhum — e isso é
 * deliberado, porque a alternativa (fingir que entrega) faria a tela parecer
 * atualizada quando não está. Em modo local, `RealtimeRefresh` cai para
 * recarga periódica, e a tela DIZ que está em modo local.
 */

let esquemaPrometido: Promise<Esquema> | null = null

/* Uma ida ao banco por processo, para as duas coisas: o mapa de chaves
   estrangeiras (que decide objeto ou lista nos embutes) e o tipo das colunas
   (que decide como um array de JavaScript é serializado). */
function prepararEsquema(): Promise<Esquema> {
  if (!esquemaPrometido) {
    esquemaPrometido = (async () => {
      const cliente = await obterPool().connect()
      try {
        return {
          relacoes: await carregarRelacoes(cliente),
          tipos: await carregarTiposDeColuna(cliente),
        }
      } finally {
        cliente.release()
      }
    })()
  }
  return esquemaPrometido
}

export interface ClienteLocal {
  from(tabela: string): Consulta
  rpc(nome: string, args?: LinhaQualquer): Consulta
  schema(nome: string): { rpc(nome: string, args?: LinhaQualquer): Consulta }
  auth: AutenticacaoLocal
  storage: { from(bucket: string): BucketLocal }
  channel(nome: string): CanalLocal
  removeChannel(canal: CanalLocal): void
}

export interface CanalLocal {
  on(): CanalLocal
  subscribe(): CanalLocal
  unsubscribe(): void
}

interface BucketLocal {
  upload(
    caminho: string,
    arquivo: File | Blob | Buffer,
    opcoes?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: { path: string } | null; error: { message: string } | null }>
  remove(caminhos: string[]): Promise<{ data: unknown; error: { message: string } | null }>
  createSignedUrl(
    caminho: string,
    segundos?: number,
  ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>
}

interface AutenticacaoLocal {
  getUser(): Promise<{ data: { user: UsuarioLocal | null }; error: { message: string } | null }>
  signInWithPassword(c: {
    email: string
    password: string
  }): Promise<{ data: unknown; error: { message: string; code?: string } | null }>
  signOut(): Promise<{ error: null }>
  updateUser(d: {
    password?: string
  }): Promise<{ data: unknown; error: { message: string; code?: string } | null }>
  resetPasswordForEmail(
    email: string,
    opcoes?: { redirectTo?: string },
  ): Promise<{ data: unknown; error: { message: string } | null }>
  exchangeCodeForSession(
    codigo: string,
  ): Promise<{ data: unknown; error: { message: string } | null }>
  admin: {
    createUser(d: {
      email: string
      password?: string
      email_confirm?: boolean
      app_metadata?: Record<string, unknown>
    }): Promise<{ data: { user: UsuarioLocal | null }; error: { message: string } | null }>
    deleteUser(id: string): Promise<{ data: unknown; error: { message: string } | null }>
  }
}

export interface UsuarioLocal {
  id: string
  email: string | null
  app_metadata: Record<string, unknown>
  user_metadata: Record<string, unknown>
}

export interface GanchosDeSessao {
  /** Lê o cookie e devolve a sessão. */
  obter(): Promise<Sessao>
  /** Grava o cookie no login. Ausente em contexto onde não dá para gravar. */
  entrar?(sub: string): Promise<void>
  sair?(): Promise<void>
}

export function criarClienteLocal(ganchos: GanchosDeSessao): ClienteLocal {
  const executor = async (sql: string, params: unknown[]) => {
    const sessao = await ganchos.obter()
    return executarNaSessao(sessao, sql, params)
  }

  const consulta = (tabela: string, esquema = 'public') =>
    new Consulta(executor, tabela, esquema, null, prepararEsquema)

  const chamar = (nome: string, args: LinhaQualquer | undefined, esquema: string) => {
    const c = new Consulta(executor, nome, esquema, args ?? {}, prepararEsquema)
    /* `rpc` já nasce em modo função: não existe `select` antes dele. */
    ;(c as unknown as { operacao: string }).operacao = 'rpc'
    return c
  }

  return {
    from: (tabela) => consulta(tabela),
    rpc: (nome, args) => chamar(nome, args, 'public'),
    schema: (esquema) => ({ rpc: (nome, args) => chamar(nome, args, esquema) }),

    auth: {
      async getUser() {
        const sessao = await ganchos.obter()
        if (!sessao.userId) return { data: { user: null }, error: { message: 'sem sessão' } }
        return {
          data: {
            user: {
              id: sessao.userId,
              email: (sessao.claims['email'] as string) ?? null,
              app_metadata: (sessao.claims['app_metadata'] as Record<string, unknown>) ?? {},
              user_metadata: {},
            },
          },
          error: null,
        }
      },

      async signInWithPassword({ email, password }) {
        const id = await autenticar(email, password)
        if (!id) {
          /* A mesma mensagem genérica do Supabase, e pelo mesmo motivo:
             distinguir "e-mail não existe" de "senha errada" entrega ao
             atacante uma forma de enumerar contas. */
          return { data: null, error: { message: 'Invalid login credentials' } }
        }
        await ganchos.entrar?.(id)
        return { data: { user: { id } }, error: null }
      },

      async signOut() {
        await ganchos.sair?.()
        return { error: null }
      },

      async updateUser({ password }) {
        const sessao = await ganchos.obter()
        if (!sessao.userId) return { data: null, error: { message: 'session_not_found' } }
        if (!password) return { data: null, error: null }
        if (password.length < 8) {
          return { data: null, error: { message: 'at least 8 characters', code: 'weak_password' } }
        }
        await trocarSenha(sessao.userId, password)
        return { data: { user: { id: sessao.userId } }, error: null }
      },

      async resetPasswordForEmail() {
        /*
         * Não há envio de e-mail no modo local — e inventar um link de
         * recuperação que "funciona" seria pior: a pessoa confiaria num fluxo
         * que não existe. A tela já responde a mesma coisa para e-mail
         * existente e inexistente, então o comportamento visível é idêntico.
         */
        return { data: {}, error: null }
      },

      async exchangeCodeForSession() {
        return { data: null, error: { message: 'recuperação por link não existe no modo local' } }
      },

      admin: {
        async createUser({ email, password, app_metadata }) {
          const { executarComoDono } = await import('./conexao')
          const linhas = await executarComoDono(
            `insert into auth.users (email, raw_app_meta_data, encrypted_password)
             values ($1, $2, case when $3::text is null then null else crypt($3, gen_salt('bf')) end)
             returning id, email, raw_app_meta_data`,
            [email, JSON.stringify(app_metadata ?? {}), password ?? null],
          )
          const u = linhas[0]
          if (!u) return { data: { user: null }, error: { message: 'não foi possível criar' } }
          return {
            data: {
              user: {
                id: String(u['id']),
                email: (u['email'] as string) ?? null,
                app_metadata: (u['raw_app_meta_data'] as Record<string, unknown>) ?? {},
                user_metadata: {},
              },
            },
            error: null,
          }
        },
        async deleteUser(id) {
          const { executarComoDono } = await import('./conexao')
          await executarComoDono(`delete from auth.users where id = $1`, [id])
          return { data: {}, error: null }
        },
      },
    },

    storage: {
      from(bucket) {
        return {
          async upload(caminho, arquivo) {
            try {
              const buffer =
                arquivo instanceof Buffer
                  ? arquivo
                  : Buffer.from(await (arquivo as Blob).arrayBuffer())
              await gravar(bucket, caminho, buffer)
              return { data: { path: caminho }, error: null }
            } catch (e) {
              return { data: null, error: { message: (e as Error).message } }
            }
          },
          async remove(caminhos) {
            await remover(bucket, caminhos)
            return { data: {}, error: null }
          },
          async createSignedUrl(caminho, segundos = SIGNED_URL_TTL) {
            try {
              return { data: { signedUrl: assinarCaminho(bucket, caminho, segundos) }, error: null }
            } catch (e) {
              return { data: null, error: { message: (e as Error).message } }
            }
          },
        }
      },
    },

    /* Tempo real não existe aqui, e o canal diz isso ficando quieto. Ver o
       cabeçalho deste arquivo. */
    channel() {
      const canal: CanalLocal = {
        on: () => canal,
        subscribe: () => canal,
        unsubscribe: () => {},
      }
      return canal
    },
    removeChannel() {},
  }
}

/** Cliente de serviço: sem sessão de usuário, com `service_role`. */
export function criarClienteDeServico(): ClienteLocal {
  return criarClienteLocal({
    obter: async () => ({ userId: null, claims: {}, papel: 'service_role' }),
  })
}

/** Cliente anônimo: `anon`, sem claims. Para rotas públicas. */
export function criarClienteAnonimo(): ClienteLocal {
  return criarClienteLocal({ obter: async () => SESSAO_ANONIMA })
}

export { sessaoDoUsuario }
