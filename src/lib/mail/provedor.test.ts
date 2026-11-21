import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provedorConfigurado } from './provedor'

/*
 * A ESCOLHA DO PROVEDOR, que é a parte que decide se o e-mail SAI.
 *
 * Sem provedor, confirmação de cadastro, convite e redefinição de senha não
 * saem — e a caixa de saída acumula em silêncio. Não é recurso a mais: é o que
 * faz a entrada pública funcionar.
 *
 * O que estes testes cobram é a ESCOLHA, não o envio. Mandar e-mail de verdade
 * num teste unitário exigiria um servidor SMTP, e um teste que depende de rede
 * falha por motivos que não são o produto.
 */

const ORIGINAL = { ...process.env }

beforeEach(() => {
  for (const k of [
    'MAIL_FROM',
    'RESEND_API_KEY',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USUARIO',
    'SMTP_SENHA',
    'SMTP_SEGURO',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  process.env = { ...ORIGINAL }
})

describe('qual provedor as variáveis descrevem', () => {
  it('sem nada configurado, não há provedor — e isso NÃO é erro', () => {
    /* O sistema roda sem canal de e-mail, como rodou até a 0057. O que não pode
       acontecer é fingir que enviou: sem provedor a drenagem devolve
       `semProvedor` e a fila fica intacta, para sair quando a chave entrar. */
    expect(provedorConfigurado()).toBeNull()
  })

  it('sem MAIL_FROM não há provedor, mesmo com o resto configurado', () => {
    /*
     * Os dois provedores recusam remetente que não lhes pertence: o Resend
     * exige domínio verificado, e o SMTP exige que o `from` seja da caixa
     * autenticada. Aceitar a configuração pela metade faria a primeira
     * mensagem de produção falhar — que é o pior momento para descobrir.
     */
    process.env.RESEND_API_KEY = 're_qualquer'
    expect(provedorConfigurado()).toBeNull()

    process.env.SMTP_HOST = 'smtp.exemplo.com.br'
    expect(provedorConfigurado()).toBeNull()
  })

  it('com chave do Resend e remetente, usa o Resend', () => {
    process.env.MAIL_FROM = 'STI <nao-responda@exemplo.com.br>'
    process.env.RESEND_API_KEY = 're_qualquer'
    expect(provedorConfigurado()?.nome).toBe('resend')
  })

  it('com SMTP configurado, usa o SMTP', () => {
    process.env.MAIL_FROM = 'STI <nao-responda@exemplo.com.br>'
    process.env.SMTP_HOST = 'smtp.hostinger.com'
    expect(provedorConfigurado()?.nome).toBe('smtp')
  })

  it('com os DOIS, o SMTP ganha — foi a escolha mais trabalhosa', () => {
    /* Configurar SMTP dá mais trabalho que colar uma chave de API. Quem o fez,
       fez de propósito, e a escolha explícita vence. */
    process.env.MAIL_FROM = 'STI <nao-responda@exemplo.com.br>'
    process.env.RESEND_API_KEY = 're_qualquer'
    process.env.SMTP_HOST = 'smtp.hostinger.com'
    expect(provedorConfigurado()?.nome).toBe('smtp')
  })

  it('porta inválida não vira provedor meio configurado', () => {
    /* Um `NaN` de porta produziria um transporte que falha em toda mensagem,
       com erro de rede — e a leitura natural seria "o servidor SMTP está fora",
       mandando a pessoa investigar o lugar errado. */
    process.env.MAIL_FROM = 'STI <nao-responda@exemplo.com.br>'
    process.env.SMTP_HOST = 'smtp.hostinger.com'
    process.env.SMTP_PORT = 'quinhentos'
    expect(provedorConfigurado()).toBeNull()
  })
})
