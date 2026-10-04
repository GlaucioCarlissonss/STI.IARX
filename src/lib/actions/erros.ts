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

/**
 * Traduz o erro do PostgREST para uma frase acionável.
 *
 * `duplicado` é a frase específica de quem chama, para o caso de chave única.
 * Os demais códigos são genéricos de verdade — e, antes disto, vazavam para a
 * tela em inglês, com nome de constraint junto.
 */
export function mensagemDeErro(error: ErroDeBanco, duplicado?: string): string {
  switch (error.code) {
    case '23505': // unique_violation
      return duplicado ?? 'Já existe um registro com estes dados.'
    case '23503': // foreign_key_violation
      return 'Este registro está vinculado a outro cadastro e não pode ser alterado ou removido.'
    case '23502': // not_null_violation
      return 'Faltou preencher um campo obrigatório.'
    /* `check_violation` e `restrict_violation` vêm das nossas próprias triggers,
       que já levantam a mensagem em português — repassar é o certo aqui. */
    case '23514':
    case '2BP01':
      return error.message
    case '42501': // insufficient_privilege
      return NAO_AFETADO
    default:
      return error.message
  }
}
