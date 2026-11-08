/**
 * O termo que a pessoa digitou, pronto para um `ilike`.
 *
 * `%` e `_` são curingas no `like` do Postgres: sem escapar, procurar por "50%"
 * casa com qualquer título que comece com "50", e procurar por "_" devolve a
 * base inteira. Não é falha de segurança — o PostgREST parametriza o valor, e
 * quem recorta o tenant é o RLS —, é resultado errado com cara de resultado.
 *
 * A contrabarra também é escapada, e é por isso que ela vem primeiro na classe:
 * sem ela, buscar por `\` produziria um escape pendurado no fim do padrão.
 */
export function paraIlike(termo: string): string {
  return `%${termo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
