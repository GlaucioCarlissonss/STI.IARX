import { describe, expect, it } from 'vitest'
import {
  AVISO_DE_INDISPONIBILIDADE,
  CODIGO_INDISPONIVEL,
  ehFalhaDeInfraestrutura,
} from './infraestrutura'

/*
 * O classificador que separa "o banco não respondeu" de "a sua conta tem
 * problema".
 *
 * Ele existe por causa de um defeito visto em tela: com o PostgreSQL parado, o
 * sistema dizia a quem entrava que a CONTA dele estava desativada, e mandava
 * procurar o administrador da empresa — que ia confirmar que a conta estava
 * ativa. O diagnóstico real estava só no log.
 *
 * O risco deste arquivo é o oposto do que parece: não é deixar de reconhecer
 * uma falha de conexão (aí a pessoa vê a mensagem genérica, que é ruim mas
 * honesta). É reconhecer DEMAIS — classificar uma senha errada como queda de
 * banco faria o sistema dizer "avise quem cuida do servidor" a cada erro de
 * digitação. Por isso metade dos casos abaixo cobra o `false`.
 */

describe('ehFalhaDeInfraestrutura', () => {
  it('reconhece o banco parado pelo código do socket', () => {
    // O caso real: `ECONNREFUSED 127.0.0.1:5433`, com o cluster derrubado.
    expect(ehFalhaDeInfraestrutura({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe(
      true,
    )
    expect(ehFalhaDeInfraestrutura({ code: 'ENOTFOUND', message: 'getaddrinfo' })).toBe(true)
    expect(ehFalhaDeInfraestrutura({ code: 'ETIMEDOUT', message: '' })).toBe(true)
    expect(ehFalhaDeInfraestrutura({ code: 'ECONNRESET', message: '' })).toBe(true)
  })

  it('reconhece o PostgreSQL dizendo que não pode atender agora', () => {
    /* Diferente do anterior: aqui o servidor RESPONDEU. Continua não sendo
       problema da conta — e `57P03` é o do banco subindo, que é exatamente a
       janela em que alguém tenta entrar logo depois de um restart. */
    expect(ehFalhaDeInfraestrutura({ code: '57P03', message: 'cannot connect now' })).toBe(true)
    expect(ehFalhaDeInfraestrutura({ code: '53300', message: 'too many connections' })).toBe(true)
    expect(ehFalhaDeInfraestrutura({ code: '08006', message: 'connection failure' })).toBe(true)
  })

  it('reconhece pelo texto quando o código se perdeu no caminho', () => {
    // Rede de segurança: alguma camada embrulhou e só sobrou a frase.
    expect(ehFalhaDeInfraestrutura(new Error('connect ECONNREFUSED 127.0.0.1:5433'))).toBe(true)
    expect(ehFalhaDeInfraestrutura(new Error('Connection terminated unexpectedly'))).toBe(true)
  })

  it('atravessa o embrulho e olha a causa', () => {
    /* `new Error('falhou', { cause })` é o padrão do próprio conserto: a sessão
       lança uma mensagem legível carregando o erro do driver. Sem olhar a
       causa, o embrulho de uma linha esconderia a classificação inteira. */
    const original = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }
    expect(ehFalhaDeInfraestrutura(new Error('Não foi possível ler o seu perfil.', { cause: original }))).toBe(
      true,
    )
  })

  it('NÃO confunde senha errada com queda de banco', () => {
    /* A asserção que impede o conserto de virar o defeito oposto. Se esta
       falhar, cada erro de digitação passa a dizer "avise quem cuida do
       servidor" — e o aviso perde o sentido justamente quando for verdade. */
    expect(ehFalhaDeInfraestrutura({ message: 'Invalid login credentials' })).toBe(false)
    expect(ehFalhaDeInfraestrutura({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(ehFalhaDeInfraestrutura({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(ehFalhaDeInfraestrutura({ code: 'PGRST116', message: 'no rows' })).toBe(false)
  })

  it('não quebra com o que não é erro', () => {
    // Chega de três lugares com formatos diferentes, e `catch` pega qualquer coisa.
    expect(ehFalhaDeInfraestrutura(null)).toBe(false)
    expect(ehFalhaDeInfraestrutura(undefined)).toBe(false)
    expect(ehFalhaDeInfraestrutura('ECONNREFUSED')).toBe(false)
    expect(ehFalhaDeInfraestrutura(42)).toBe(false)
    expect(ehFalhaDeInfraestrutura({})).toBe(false)
  })
})

describe('o aviso que a pessoa lê', () => {
  it('nega a culpa da conta e diz a quem avisar', () => {
    /* As duas coisas que faltavam na mensagem antiga. "Conta desativada"
       afirmava o contrário da primeira e mandava para o destinatário errado. */
    expect(AVISO_DE_INDISPONIBILIDADE).toMatch(/não é problema da sua conta/i)
    expect(AVISO_DE_INDISPONIBILIDADE).toMatch(/quem cuida do servidor/i)
  })

  it('não vaza host, porta nem nome de banco', () => {
    // Isso vive no log, que é onde serve. Na tela é ruído — e, para quem não
    // deveria conhecer a topologia, é informação de graça.
    expect(AVISO_DE_INDISPONIBILIDADE).not.toMatch(/\d+\.\d+\.\d+\.\d+|:\d{4}|postgres/i)
  })

  it('tem código estável além da prosa', () => {
    expect(CODIGO_INDISPONIVEL).toBe('banco_indisponivel')
  })
})
