import { Pool, type PoolClient } from 'pg'
import { configurarTipos } from './tipos'
import { carregarRelacoes, type Relacao } from './relacoes'
import type { LinhaQualquer } from './consulta'

/**
 * A conexão do modo local — e o lugar onde o RLS continua valendo.
 *
 * ## A decisão que sustenta tudo
 *
 * Cada consulta roda **numa transação própria**, com:
 *
 *     set local role <anon | authenticated | service_role>
 *     set local request.jwt.claims = '<os claims do usuário>'
 *
 * É literalmente o que o PostgREST faz. As policies são as mesmas, as funções
 * `app.current_tenant_id()` e `auth.uid()` leem o mesmo GUC, e a negação se
 * comporta igual: zero linhas em leitura e escrita, exceção no `with check` do
 * insert.
 *
 * Sem o `set local role`, a conexão seria a do dono do banco — que tem
 * `BYPASSRLS` — e **todo o isolamento entre tenants desapareceria em silêncio**.
 * O app funcionaria melhor local do que em produção, que é a pior forma de um
 * ambiente de desenvolvimento mentir.
 *
 * ## Por que transação por consulta, e não por requisição
 *
 * `set local` só dura a transação, e é isso que impede o vazamento de claims
 * entre requisições quando a conexão volta para o pool. `set` sem `local`
 * duraria a conexão inteira: a próxima requisição a pegar aquela conexão
 * herdaria a sessão de outra pessoa.
 *
 * O preço é não ter transação atravessando várias chamadas do app. O app não
 * usa isso — quando precisa de atomicidade, ela está dentro de uma função do
 * banco, que é onde esta base sempre a colocou.
 */

let pool: Pool | null = null

export function urlDoBanco(): string {
  return (
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:5433/sti_iarx_dev'
  )
}

export function obterPool(): Pool {
  if (!pool) {
    /* Antes de qualquer conexão: os parsers são globais do módulo `pg`, e
       registrá-los depois deixaria as primeiras consultas com o formato antigo. */
    configurarTipos()
    pool = new Pool({ connectionString: urlDoBanco(), max: 10 })
    /* Sem isto, um erro em conexão ociosa derruba o processo inteiro do Next —
       e o sintoma é o servidor morrendo sozinho, sem pista nenhuma. */
    pool.on('error', (e) => console.error('[db] erro em conexão ociosa:', e.message))
  }
  return pool
}

export interface Sessao {
  /** `sub` do JWT: o id do usuário. Nulo em sessão anônima. */
  userId: string | null
  /** Vai inteiro para `request.jwt.claims`. */
  claims: Record<string, unknown>
  papel: 'anon' | 'authenticated' | 'service_role'
}

export const SESSAO_ANONIMA: Sessao = { userId: null, claims: {}, papel: 'anon' }

export async function executarNaSessao(
  sessao: Sessao,
  sql: string,
  params: unknown[],
): Promise<{ rows: LinhaQualquer[]; relacoes: Relacao[] }> {
  const cliente = await obterPool().connect()
  try {
    const relacoes = await carregarRelacoes(cliente)
    await cliente.query('begin')
    try {
      await aplicarSessao(cliente, sessao)
      const r = await cliente.query(sql, params)
      await cliente.query('commit')
      return { rows: r.rows as LinhaQualquer[], relacoes }
    } catch (e) {
      await cliente.query('rollback')
      throw e
    }
  } finally {
    cliente.release()
  }
}

async function aplicarSessao(cliente: PoolClient, sessao: Sessao): Promise<void> {
  /*
   * `set local role` não aceita parâmetro — o nome do papel faz parte da
   * sintaxe. Por isso ele é validado contra uma lista fechada aqui, em vez de
   * interpolado como veio: é o único ponto desta camada em que algo entra no
   * SQL sem ser parâmetro.
   */
  const papel =
    sessao.papel === 'authenticated' || sessao.papel === 'service_role'
      ? sessao.papel
      : 'anon'
  await cliente.query(`set local role ${papel}`)

  const claims = JSON.stringify(sessao.claims ?? {})
  await cliente.query(`select set_config('request.jwt.claims', $1, true)`, [claims])
}

/** Executa como dono do banco, sem RLS. Só para login e provisionamento. */
export async function executarComoDono(
  sql: string,
  params: unknown[],
): Promise<LinhaQualquer[]> {
  const r = await obterPool().query(sql, params)
  return r.rows as LinhaQualquer[]
}
