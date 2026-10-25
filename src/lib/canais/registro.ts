import { bitrix24 } from './bitrix24'
import { email } from './email'
import { n8n } from './n8n'
import { whatsapp } from './whatsapp'
import type { Provedor } from './tipos'

/**
 * De `kind` para adaptador.
 *
 * O mapa é exaustivo por tipo (`Record<Kind, Provedor>`), então acrescentar um
 * tipo em `channels.kind` sem escrever o adaptador **não compila**. É a trava que
 * impede um canal de ser criado no banco e descoberto em produção como "não faz
 * nada": o tipo novo no CHECK da migração e o adaptador novo aqui andam juntos ou
 * o build quebra.
 */
export type TipoDeCanal = 'whatsapp' | 'email' | 'bitrix24' | 'n8n'

const PROVEDORES: Record<TipoDeCanal, Provedor> = {
  whatsapp,
  email,
  bitrix24,
  n8n,
}

export function provedorDoCanal(kind: string): Provedor | null {
  return PROVEDORES[kind as TipoDeCanal] ?? null
}

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
