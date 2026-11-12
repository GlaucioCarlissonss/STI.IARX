/**
 * A guarda de segredos, apontada para o ambiente DE VERDADE.
 *
 * ## Por que isto existe separado do teste unitário
 *
 * `src/lib/segredos.test.ts` prova que a função ACUSA — ela recebe um ambiente
 * de mentira com `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` dentro e confere que o
 * resultado não é vazio. É o teste certo para a função, e ele não protege de
 * nada no dia do erro: o erro acontece no ambiente, não no teste.
 *
 * Este script roda a mesma função contra `process.env` do processo que vai
 * construir a aplicação. É a diferença entre "a guarda funciona" e "a guarda
 * está montada na porta".
 *
 * ## Como rodar
 *
 *     node --experimental-strip-types scripts/conferir-segredos.ts
 *
 * Sai com 1 se encontrar segredo indo para o navegador, e o CI para aí — antes
 * do build que escreveria o valor dentro do pacote .js.
 */
import { explicarSegredosExpostos, segredosExpostos } from '../src/lib/segredos.ts'

const achados = segredosExpostos(process.env)

if (achados.length > 0) {
  console.error('')
  console.error('################  SEGREDO INDO PARA O NAVEGADOR  ################')
  console.error('')
  console.error(explicarSegredosExpostos(achados))
  console.error('')
  process.exit(1)
}

const publicas = Object.keys(process.env).filter((v) => v.startsWith('NEXT_PUBLIC_'))
console.log(`ok  ${publicas.length} variável(is) NEXT_PUBLIC_, nenhuma com cara de segredo.`)
for (const v of publicas.sort()) console.log(`    · ${v}`)
