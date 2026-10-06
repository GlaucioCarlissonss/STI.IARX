/**
 * Erros de banco traduzidos uma vez só.
 *
 * `NAO_AFETADO` estava declarado em **11 arquivos** com o mesmo texto, e o
 * tratamento de código de erro aparecia em **29 pontos**, cada um reimplementando
 * o mesmo `if`.
 *
 * O que NÃO foi unificado, de propósito: a mensagem de duplicidade. "Já existe um
 * ativo com este patrimônio" e "Já existe uma área com este nome nesta filial"
 * dizem à pessoa onde está o conflito; trocá-las por um genérico "registro
 * duplicado" seria perder informação em nome de ter menos linhas. Por isso ela
 * continua vindo de quem chama.
 */

/**
 * RLS que nega não devolve erro — devolve zero linhas. Sem checar o tamanho do
 * resultado, a tela diria "salvo" e o dado continuaria como estava: a pior falha
 * possível num cadastro, porque é silenciosa e convincente.
 */
export const NAO_AFETADO = 'Não foi possível salvar: registro não encontrado ou sem permissão.'

export interface ErroDeBanco {
  code?: string
  message: string
}

/** O que a pessoa lê quando não sabemos dizer nada de útil sobre a falha. */
const GENERICA = 'Não foi possível concluir. Tente de novo; se continuar, avise o suporte'

/**
 * A mensagem veio de uma trigger NOSSA, ou do próprio Postgres?
 *
 * Dezessete triggers desta base levantam `check_violation` **de propósito**, com
 * a frase já escrita em português — "Área não pertence à filial do ativo". Mas
 * `23514` é também o código de uma CHECK constraint comum, e aí quem escreve a
 * frase é o Postgres: `new row for relation "clients" violates check constraint
 * "clients_color_hex"`. Repassar essa segunda entrega nome de tabela e de
 * constraint a quem só queria salvar um cadastro — e em inglês.
 *
 * Distinguir pelo texto é heurística, e fica admitido como tal. A alternativa
 * seria dar às nossas triggers um SQLSTATE próprio, que é mudança de banco e não
 * cabe numa entrega de código e visual; até lá, os marcadores abaixo são
 * gerados pelo Postgres e não aparecem em nenhuma mensagem escrita por nós.
 */
function pareceMensagemDoPostgres(mensagem: string): boolean {
  return /violates .*constraint|new row for relation|null value in column|invalid input syntax/i.test(
    mensagem,
  )
}

/**
 * Traduz o erro do PostgREST para uma frase acionável.
 *
 * **Nenhum caminho devolve detalhe técnico interno.** Antes desta revisão dois
 * devolviam: o `default`, que repassava cru qualquer erro inesperado, e o
 * `23514`, que repassava também as CHECK constraints do schema. Os dois agora
 * passam pelo filtro acima, e o texto cru vai para o log do servidor — onde
 * serve a quem investiga, em vez de assustar quem trabalha.
 *
 * O SQLSTATE acompanha a mensagem genérica pela mesma razão que o `digest`
 * acompanha a tela de erro: sozinho não diz nada a ninguém, e é exatamente o que
 * o suporte precisa para achar a linha certa no log.
 */
export function mensagemDeErro(error: ErroDeBanco, duplicado?: string): string {
  switch (error.code) {
    case '23505': // unique_violation
      return duplicado ?? 'Já existe um registro com estes dados.'
    case '23503': // foreign_key_violation
      return 'Este registro está vinculado a outro cadastro e não pode ser alterado ou removido.'
    case '23502': // not_null_violation
      return 'Faltou preencher um campo obrigatório.'
    case '23514': // check_violation — nossa trigger, ou uma CHECK do schema
    case '2BP01': // restrict_violation — idem
      if (!pareceMensagemDoPostgres(error.message)) return error.message
      console.error('[erro de banco]', error.code, error.message)
      return 'Os dados informados não atendem a uma regra do sistema. Revise os campos e tente de novo.'
    case '42501': // insufficient_privilege
      return NAO_AFETADO
    default:
      console.error('[erro de banco]', error.code, error.message)
      return error.code ? `${GENERICA} (código ${error.code}).` : `${GENERICA}.`
  }
}
