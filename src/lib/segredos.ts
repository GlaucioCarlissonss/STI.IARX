/**
 * A fronteira entre o que pode ir ao navegador e o que não pode.
 *
 * ## O erro que este módulo existe para tornar impossível
 *
 * O Next escreve toda variável `NEXT_PUBLIC_*` **dentro do pacote que vai para
 * o navegador**. Não é "exposta ao servidor do cliente": é texto legível no
 * arquivo `.js` que qualquer visitante baixa.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` ignora todo o RLS. Prefixá-la com `NEXT_PUBLIC_`
 * — por copiar a linha errada do `.env.example`, por tentar "resolver" um
 * `undefined` no cliente — entrega a base inteira de todos os tenants a quem
 * abrir o inspetor. É um erro de uma linha, cometido com a melhor das
 * intenções, e impossível de notar olhando a tela: a aplicação funciona
 * perfeitamente.
 *
 * O comentário na migração 0001 avisa. Avisar não basta — por isso aqui há uma
 * função, e um teste que falha o CI.
 *
 * ## Por que uma lista de padrões, e não uma lista de nomes
 *
 * Uma lista de nomes proibidos protege contra os erros que já conhecemos. O
 * próximo segredo a entrar no projeto não está nela — e é justamente o que
 * ninguém vai lembrar de acrescentar. O padrão cobre o que ainda não existe.
 */

/**
 * O que, num nome de variável, denuncia um segredo.
 *
 * `KEY` sozinho não entra: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` é pública por
 * desenho — uma chave de mapa restrita por domínio, que o navegador precisa
 * ter para carregar o mapa. Marcá-la como erro ensinaria a desligar a guarda.
 */
const MARCAS_DE_SEGREDO: readonly { padrao: RegExp; porque: string }[] = [
  { padrao: /SERVICE_ROLE/i, porque: 'a chave de serviço ignora todo o RLS' },
  { padrao: /SECRET/i, porque: 'o nome diz que é segredo' },
  { padrao: /PASSWORD|SENHA/i, porque: 'é uma senha' },
  { padrao: /PRIVATE/i, porque: 'o nome diz que é privado' },
  { padrao: /_TOKEN$|^TOKEN/i, porque: 'tokens autenticam quem os porta' },
  { padrao: /DATABASE_URL|POSTGRES_URL/i, porque: 'carrega usuário e senha do banco' },
  { padrao: /ANTHROPIC|OPENAI|RESEND/i, porque: 'é credencial de provedor, cobrada por uso' },
]

/**
 * As públicas por desenho, com o motivo de cada uma.
 *
 * Lista curta e explícita: acrescentar algo aqui é uma decisão, não um
 * descuido. `ANON_KEY` entra porque é o caso que mais confunde — ela parece
 * secreta e não é: o Supabase a publica em toda aplicação de navegador, e o
 * que protege os dados é o RLS, não o sigilo dela.
 */
const PUBLICAS_POR_DESENHO: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    'pública por desenho — quem protege os dados é o RLS, não o sigilo dela',
  NEXT_PUBLIC_SUPABASE_URL: 'é um endereço, não uma credencial',
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:
    'o navegador precisa dela para carregar o mapa; restrinja-a por domínio no console',
}

export interface SegredoExposto {
  variavel: string
  porque: string
}

/**
 * Procura segredo entre as variáveis que vão para o navegador.
 *
 * Recebe o ambiente como parâmetro em vez de ler `process.env` direto: é o que
 * permite ao teste provar que a guarda ACUSA, e não só que ela não reclama do
 * ambiente de hoje. Uma guarda nunca exercitada é indistinguível de uma guarda
 * quebrada.
 */
export function segredosExpostos(
  ambiente: Readonly<Record<string, string | undefined>>,
): SegredoExposto[] {
  const achados: SegredoExposto[] = []

  for (const variavel of Object.keys(ambiente)) {
    if (!variavel.startsWith('NEXT_PUBLIC_')) continue
    if (variavel in PUBLICAS_POR_DESENHO) continue

    const marca = MARCAS_DE_SEGREDO.find((m) => m.padrao.test(variavel))
    if (marca) achados.push({ variavel, porque: marca.porque })
  }

  return achados
}

/**
 * A mensagem que alguém vai ler no CI vermelho, às pressas.
 *
 * Ela diz o que fazer — tirar o prefixo —, e não só o que está errado. A
 * correção é de uma linha, e quem recebeu o erro costuma não saber qual.
 */
export function explicarSegredosExpostos(achados: readonly SegredoExposto[]): string {
  if (achados.length === 0) return ''
  const linhas = achados.map(
    (a) =>
      `  · ${a.variavel} — ${a.porque}.\n    Corrija tirando o prefixo: ${a.variavel.replace(/^NEXT_PUBLIC_/, '')}`,
  )
  return [
    `${achados.length} variável(is) com cara de segredo vai(ão) para o navegador:`,
    ...linhas,
    '',
    'Tudo que começa com NEXT_PUBLIC_ é escrito dentro do pacote .js que o',
    'visitante baixa. Não é "exposto ao servidor": é texto legível na aba de rede.',
  ].join('\n')
}
