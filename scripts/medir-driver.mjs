/*
 * Mede o driver local sob concorrência, e descobre onde ele satura.
 *
 * POR QUE ESTE SCRIPT EXISTE
 * --------------------------
 * `docs/22` dizia, em "o que continua não verificado": *nada foi medido sob
 * carga; o pool tem dez conexões e uma transação por consulta; com concorrência
 * de verdade, esse número é a primeira coisa a olhar*. Era um palpite sobre um
 * palpite — o `max: 10` nunca foi escolhido, foi herdado.
 *
 * O QUE ELE MEDE, E O QUE NÃO MEDE
 * --------------------------------
 * Mede o custo do CAMINHO do driver: abrir transação, `set local role`,
 * `set_config` dos claims, a consulta, o commit. É esse custo por consulta que
 * o `max` do pool governa.
 *
 * Não mede o Next.js, nem a rede, nem a renderização. Uma tela é mais lenta que
 * isto; o que este número diz é quanto dessa lentidão é do banco.
 *
 * Uso:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/sti_iarx_dev \
 *     node scripts/medir-driver.mjs
 *   node scripts/medir-driver.mjs --max 20      # testa outro tamanho de pool
 */
import { Pool } from 'pg'

const URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/sti_iarx_dev'

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`)
  return i >= 0 ? Number(process.argv[i + 1]) : padrao
}

const MAX = arg('max', 10)
const CONSULTAS = arg('consultas', 400)
const CONCORRENCIAS = [1, 2, 5, 10, 20, 40, 80]

const pool = new Pool({ connectionString: URL, max: MAX })

/*
 * A mesma coisa que `executarNaSessao` faz: transação própria, papel trocado,
 * claims no GUC. Reproduzida aqui em vez de importada porque o módulo é
 * TypeScript e este script roda sem transpilador — e porque medir uma CÓPIA do
 * caminho obriga a manter a cópia honesta, que é mais fácil de conferir do que
 * um mock.
 */
const CLAIMS = JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', role: 'service_role' })

async function umaConsulta() {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role service_role')
    await c.query("select set_config('request.jwt.claims', $1, true)", [CLAIMS])
    await c.query('select id, title, status from public.tickets order by created_at desc limit 20')
    await c.query('commit')
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

function percentil(valores, p) {
  const ordenado = [...valores].sort((a, b) => a - b)
  return ordenado[Math.min(ordenado.length - 1, Math.floor((p / 100) * ordenado.length))]
}

async function medir(concorrencia) {
  const tempos = []
  let restantes = CONSULTAS
  const inicio = performance.now()

  async function trabalhador() {
    while (restantes > 0) {
      restantes -= 1
      const t0 = performance.now()
      await umaConsulta()
      tempos.push(performance.now() - t0)
    }
  }

  await Promise.all(Array.from({ length: concorrencia }, trabalhador))
  const duracao = (performance.now() - inicio) / 1000

  return {
    concorrencia,
    porSegundo: Math.round(CONSULTAS / duracao),
    mediana: +percentil(tempos, 50).toFixed(1),
    p95: +percentil(tempos, 95).toFixed(1),
    pior: +Math.max(...tempos).toFixed(1),
  }
}

// Aquecimento: a primeira conexão paga o handshake e o cache de tipos, e sem
// isto ela apareceria como "a concorrência 1 é a mais lenta de todas".
await umaConsulta()

console.log(`pool max=${MAX}, ${CONSULTAS} consultas por rodada\n`)
console.log('conc.  req/s   mediana     p95    pior')
for (const c of CONCORRENCIAS) {
  const r = await medir(c)
  console.log(
    String(r.concorrencia).padStart(4) +
      String(r.porSegundo).padStart(8) +
      `${r.mediana}ms`.padStart(10) +
      `${r.p95}ms`.padStart(8) +
      `${r.pior}ms`.padStart(8),
  )
}

await pool.end()
