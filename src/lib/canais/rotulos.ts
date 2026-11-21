/**
 * O que a TELA precisa saber sobre os canais — e nada além disso.
 *
 * ## Por que isto é um arquivo separado de `registro.ts`
 *
 * `registro.ts` importa os quatro adaptadores, e o de e-mail importa o provedor
 * de envio, que importa `nodemailer`, que abre socket (`node:net`). Nada disso
 * existe no navegador.
 *
 * Enquanto os rótulos moravam lá, os componentes de cliente de
 * `/conversas/canais` arrastavam a cadeia inteira para o pacote do navegador —
 * e o build morria com "the chunking context does not support external modules
 * (request: node:net)", apontando a PÁGINA DE CANAIS, que não tem nada a ver
 * com envio de e-mail. O que as ligava era o grafo de módulos, não o assunto.
 *
 * `serverExternalPackages` não resolve: ele fala do pacote do servidor, e o
 * problema era o do cliente. Import dinâmico também não: o chunk do navegador
 * continua sendo gerado.
 *
 * O conserto é separar o que é de tela do que é de servidor — que é a mesma
 * regra que esta base aplica entre domínio e transporte, aplicada um nível
 * acima.
 */
export type TipoDeCanal = 'whatsapp' | 'email' | 'bitrix24' | 'n8n'

/** Como a tela escreve cada tipo. */
export const ROTULO_DO_CANAL: Record<TipoDeCanal, string> = {
  whatsapp: 'WhatsApp',
  email: 'E-mail',
  bitrix24: 'Bitrix24',
  n8n: 'N8N (genérico)',
}

/**
 * O que cada tipo precisa para funcionar, em português, para a tela de
 * configuração dizer antes de a pessoa descobrir errando.
 */
export const EXIGENCIAS_DO_CANAL: Record<TipoDeCanal, string[]> = {
  whatsapp: [
    'Conta Business verificada na Meta e um número dedicado',
    '`secret_ref`: a variável com o access token (envio)',
    '`config.app_secret_ref`: a variável com o App Secret (assinatura do webhook)',
    '`config.phone_number_id`: o id do número, do painel da Meta',
    'Na Meta, o verify token do webhook é o MESMO token da URL',
  ],
  email: [
    'Um provedor de recebimento (Resend, Postmark, Mailgun) apontando para a URL do canal',
    'A resposta sai pela caixa de saída já existente: RESEND_API_KEY e MAIL_FROM',
    'Restringir a origem ao IP do provedor no proxy — este canal não confere assinatura',
  ],
  bitrix24: [
    '`secret_ref`: a variável com a URL do webhook de ENTRADA (ela contém o segredo)',
    'No Bitrix24, um webhook de SAÍDA nos eventos de mensagem apontando para a URL do canal',
    '`config.application_token_ref` (opcional): a variável com o application_token, para conferir a origem',
  ],
  n8n: [
    'Um fluxo no N8N com um nó HTTP apontando para a URL do canal',
    '`secret_ref` (ou `config.url`): para onde a resposta volta',
    'Este canal não confere assinatura: a URL é a credencial',
  ],
}
