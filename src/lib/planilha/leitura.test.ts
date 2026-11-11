import { describe, expect, it } from 'vitest'
import {
  desfazerNeutralizacao,
  descobrirSeparador,
  lerCsv,
  normalizarTitulo,
  PlanilhaInvalida,
  sugerirDePara,
} from './leitura'

/*
 * O que estes testes protegem são os casos em que o leitor erra em SILÊNCIO:
 * colunas trocadas, uma linha a menos, um apóstrofo grudado. Nenhum deles
 * levanta erro — todos produzem uma importação que parece ter dado certo.
 */

describe('descobrirSeparador', () => {
  it('prefere o ponto e vírgula, que é o do Excel em português', () => {
    expect(descobrirSeparador('a;b;c\n1;2;3')).toBe(';')
  })

  it('não se engana com vírgula DENTRO de aspas', () => {
    /* Sem olhar as aspas, a vírgula ganharia (2 contra 1) e o arquivo inteiro
       sairia com as colunas trocadas — erro que só aparece depois de importar. */
    expect(descobrirSeparador('"Silva, João";"Rua A, 10"')).toBe(';')
  })

  it('aceita vírgula quando é mesmo o separador', () => {
    expect(descobrirSeparador('a,b,c\n1,2,3')).toBe(',')
  })
})

describe('desfazerNeutralizacao', () => {
  it('tira o apóstrofo que a nossa exportação põe', () => {
    // Sem isto, exportar → corrigir → importar devolve "'-3" onde havia "-3".
    expect(desfazerNeutralizacao("'-3")).toBe('-3')
    expect(desfazerNeutralizacao("'+55 11 90000-0000")).toBe('+55 11 90000-0000')
    expect(desfazerNeutralizacao("'=SOMA(A1)")).toBe('=SOMA(A1)')
  })

  it('NÃO toca em nome que legitimamente começa com apóstrofo', () => {
    expect(desfazerNeutralizacao("'t Hooft")).toBe("'t Hooft")
    expect(desfazerNeutralizacao("O'Brien")).toBe("O'Brien")
  })
})

describe('lerCsv', () => {
  it('lê cabeçalho e corpo, numerando a linha como ela está no ARQUIVO', () => {
    const p = lerCsv('nome;cnpj\nAcme;123\nBeta;456')
    expect(p.cabecalho).toEqual(['nome', 'cnpj'])
    expect(p.linhas.map((l) => l.numero)).toEqual([2, 3])
    expect(p.linhas[1].celulas).toEqual(['Beta', '456'])
  })

  it('mantém o separador dentro de aspas como parte do campo', () => {
    const p = lerCsv('nome;endereco\n"Silva, João";"Rua A, 10"')
    expect(p.linhas[0].celulas).toEqual(['Silva, João', 'Rua A, 10'])
  })

  it('entende aspas escapadas e quebra de linha dentro do campo', () => {
    const p = lerCsv('titulo;descricao\n"Erro ""crítico""";"linha 1\nlinha 2"')
    expect(p.linhas[0].celulas[0]).toBe('Erro "crítico"')
    expect(p.linhas[0].celulas[1]).toBe('linha 1\nlinha 2')
    expect(p.linhas).toHaveLength(1)
  })

  it('trata CRLF como UMA quebra', () => {
    // Com \r\n lido como duas, sairia uma linha em branco entre todas.
    const p = lerCsv('a;b\r\n1;2\r\n3;4\r\n')
    expect(p.linhas).toHaveLength(2)
  })

  it('não perde a última linha quando o arquivo não termina em quebra', () => {
    const p = lerCsv('a;b\n1;2\n3;4')
    expect(p.linhas).toHaveLength(2)
    expect(p.linhas[1].celulas).toEqual(['3', '4'])
  })

  it('come o BOM, que grudaria no primeiro cabeçalho', () => {
    const p = lerCsv('﻿Razão Social;CNPJ\nAcme;123')
    expect(p.cabecalho[0]).toBe('Razão Social')
  })

  it('recusa planilha vazia e planilha só com cabeçalho, dizendo qual é o caso', () => {
    expect(() => lerCsv('')).toThrow(PlanilhaInvalida)
    expect(() => lerCsv('nome;cnpj')).toThrow(/só tem o cabeçalho/)
  })

  it('recusa arquivo grande demais em vez de travar a conferência', () => {
    const grande = ['a', ...Array.from({ length: 5001 }, (_, i) => String(i))].join('\n')
    expect(() => lerCsv(grande)).toThrow(/limite por envio/)
  })
})

describe('sugerirDePara', () => {
  const campos = [
    { nome: 'legal_name', titulo: 'Razão social' },
    { nome: 'cnpj', titulo: 'CNPJ' },
    { nome: 'trade_name', titulo: 'Nome fantasia', sinonimos: ['fantasia'] },
  ]

  it('ignora acento, caixa e pontuação ao casar', () => {
    const mapa = sugerirDePara(['RAZAO_SOCIAL', 'Cnpj'], campos)
    expect(mapa).toEqual({ legal_name: 0, cnpj: 1 })
  })

  it('aceita sinônimo declarado pelo recurso', () => {
    expect(sugerirDePara(['Fantasia'], campos)).toEqual({ trade_name: 0 })
  })

  it('deixa de fora o que não reconheceu, em vez de adivinhar por posição', () => {
    // Adivinhar acerta no exemplo e erra no arquivo de verdade.
    expect(sugerirDePara(['Coluna A', 'Coluna B'], campos)).toEqual({})
  })

  it('não casa com coluna de cabeçalho vazio', () => {
    expect(sugerirDePara(['', 'CNPJ'], campos)).toEqual({ cnpj: 1 })
  })
})

describe('normalizarTitulo', () => {
  it('reduz as grafias que querem dizer a mesma coluna', () => {
    const esperado = 'razaosocial'
    for (const t of ['Razão Social', 'razao_social', 'RAZÃO  SOCIAL', 'razão-social']) {
      expect(normalizarTitulo(t)).toBe(esperado)
    }
  })
})
