import { describe, expect, it } from 'vitest'
import {
  chaveDaLinha,
  conferirCelula,
  conferirCnpj,
  conferirData,
  conferirLinha,
  conferirNumero,
  faltamObrigatorias,
  soDigitos,
} from './conferencia'
import { recursoPorChave } from './recursos'

const clientes = recursoPorChave('clientes')!

describe('conferirData', () => {
  it('aceita pt-BR e ISO, e devolve sempre ISO', () => {
    expect(conferirData('31/12/2026')).toEqual({ valor: '2026-12-31' })
    expect(conferirData('2026-12-31')).toEqual({ valor: '2026-12-31' })
    expect(conferirData('1/3/2026')).toEqual({ valor: '2026-03-01' })
  })

  it('recusa data que NÃO EXISTE, em vez de consertá-la em silêncio', () => {
    /* `new Date(2026, 1, 31)` vira 3 de março sem reclamar. Numa importação de
       garantias, isso move a data de vencimento sem ninguém ver. */
    const r = conferirData('31/02/2026')
    expect(r.erro).toMatch(/não existe/)
  })

  it('diz o que esperava quando o formato é outro', () => {
    expect(conferirData('12-31-2026').erro).toMatch(/31\/12\/2026 ou 2026-12-31/)
  })

  it('desconfia de ano fora do razoável', () => {
    expect(conferirData('31/12/0202').erro).toMatch(/fora do razoável/)
  })
})

describe('conferirNumero', () => {
  it('lê o formato pt-BR', () => {
    expect(conferirNumero('1.234,56')).toEqual({ valor: 1234.56 })
    expect(conferirNumero('0,5')).toEqual({ valor: 0.5 })
    expect(conferirNumero('R$ 1.200,00')).toEqual({ valor: 1200 })
  })

  it('lê o formato en-US', () => {
    expect(conferirNumero('1234.56')).toEqual({ valor: 1234.56 })
  })

  it('NÃO divide por mil quando o ponto é separador de milhar', () => {
    // Ler "1.234" como 1,234 reduziria o valor em mil vezes, calado.
    expect(conferirNumero('1.234')).toEqual({ valor: 1234 })
    expect(conferirNumero('12.345.678')).toEqual({ valor: 12345678 })
  })

  it('cobra inteiro onde o campo é inteiro', () => {
    expect(conferirNumero('36', true)).toEqual({ valor: 36 })
    expect(conferirNumero('36,5', true).erro).toMatch(/inteiro/)
  })

  it('recusa texto dizendo o que veio', () => {
    expect(conferirNumero('doze').erro).toMatch(/“doze” não é um número/)
  })
})

describe('conferirCnpj', () => {
  it('aceita CNPJ válido com e sem pontuação, e devolve só os dígitos', () => {
    expect(conferirCnpj('11.222.333/0001-81')).toEqual({ valor: '11222333000181' })
    expect(conferirCnpj('11222333000181')).toEqual({ valor: '11222333000181' })
  })

  it('recusa dígito verificador errado — que criaria um cliente duplicado', () => {
    expect(conferirCnpj('11.222.333/0001-45').erro).toMatch(/dígito verificador/)
  })

  it('recusa tamanho errado e sequência repetida', () => {
    expect(conferirCnpj('123').erro).toMatch(/14 dígitos/)
    expect(conferirCnpj('11111111111111').erro).toMatch(/não é um CNPJ válido/)
  })
})

describe('soDigitos', () => {
  it('faz a mesma empresa escrita de dois jeitos virar a mesma chave', () => {
    expect(soDigitos('11.222.333/0001-44')).toBe(soDigitos('11222333000144'))
  })
})

describe('conferirCelula', () => {
  const obrigatorio = clientes.campos.find((c) => c.nome === 'legal_name')!
  const opcional = clientes.campos.find((c) => c.nome === 'trade_name')!
  const situacao = clientes.campos.find((c) => c.nome === 'status')!

  it('nomeia o campo que faltou', () => {
    expect(conferirCelula('', obrigatorio).erro).toBe('Razão social é obrigatório.')
  })

  it('vazio opcional vira nulo, e não string vazia', () => {
    // String vazia no banco aparece como "campo preenchido com nada".
    expect(conferirCelula('  ', opcional)).toEqual({ valor: null })
  })

  it('aceita a opção escrita como a pessoa escreve', () => {
    expect(conferirCelula('Ativo', situacao)).toEqual({ valor: 'active' })
    expect(conferirCelula('PROSPECTO', situacao)).toEqual({ valor: 'prospect' })
  })

  it('lista o que é aceito quando a opção não existe', () => {
    expect(conferirCelula('pendente', situacao).erro).toMatch(/Use: ativo, inativo, prospecto/)
  })

  it('recusa texto acima do limite dizendo os dois números', () => {
    const r = conferirCelula('x'.repeat(200), obrigatorio)
    expect(r.erro).toMatch(/200 caracteres, e o limite é 160/)
  })
})

describe('conferirLinha', () => {
  const dePara = { cnpj: 0, legal_name: 1, status: 2 }

  it('junta TODOS os erros da linha, não só o primeiro', () => {
    // Parar no primeiro faria a pessoa corrigir, reenviar e descobrir o segundo.
    const l = conferirLinha(clientes, dePara, ['11222333000181', '', 'pendente'], 7)
    expect(l.erros).toHaveLength(2)
    expect(l.numero).toBe(7)
  })

  it('guarda o texto cru por título, para o arquivo de correção', () => {
    const l = conferirLinha(clientes, dePara, ['11222333000181', 'Acme', 'ativo'], 2)
    expect(l.cru['Razão social']).toBe('Acme')
    expect(l.valores.status).toBe('active')
  })
})

describe('faltamObrigatorias', () => {
  it('acusa a coluna que não foi casada ANTES de ler as linhas', () => {
    /* Sem isto, um arquivo de 300 linhas sem CNPJ produz 300 recusas iguais e
       afoga a mensagem que resolveria tudo. */
    expect(faltamObrigatorias(clientes, { legal_name: 0 })).toEqual(['CNPJ'])
  })

  it('não reclama quando tudo o que importa está casado', () => {
    expect(faltamObrigatorias(clientes, { cnpj: 0, legal_name: 1 })).toEqual([])
  })
})

describe('chaveDaLinha', () => {
  it('ignora caixa, para a mesma chave não virar duas', () => {
    const a = conferirLinha(clientes, { cnpj: 0, legal_name: 1 }, ['11222333000181', 'Acme'], 2)
    const b = conferirLinha(clientes, { cnpj: 0, legal_name: 1 }, ['11222333000181', 'ACME'], 3)
    expect(chaveDaLinha(clientes, a)).toBe(chaveDaLinha(clientes, b))
  })

  it('é nula quando a chave não veio — a linha não dá para comparar', () => {
    const l = conferirLinha(clientes, { cnpj: 0, legal_name: 1 }, ['', 'Acme'], 2)
    expect(chaveDaLinha(clientes, l)).toBeNull()
  })

  it('compõe as duas metades quando a chave tem dois campos', () => {
    const leituras = recursoPorChave('leituras')!
    const l = conferirLinha(
      leituras,
      { equipment_id: 0, read_on: 1, reading: 2 },
      ['EQP-0412', '31/10/2026', '1200'],
      2,
    )
    expect(chaveDaLinha(leituras, l)).toBe('eqp-0412\u00002026-10-31')
  })
})
