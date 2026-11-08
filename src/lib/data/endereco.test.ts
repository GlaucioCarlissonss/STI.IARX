import { describe, expect, it } from 'vitest'
import { comParametros } from './endereco'
import { paraIlike } from './ilike'

describe('comParametros', () => {
  it('preserva os filtros que já estavam', () => {
    const r = comParametros('/tickets', { busca: 'rede', fila: 'infra' }, { prioridade: 'alta' })
    expect(r).toContain('busca=rede')
    expect(r).toContain('fila=infra')
    expect(r).toContain('prioridade=alta')
  })

  it('remove o parâmetro com null, undefined ou vazio — é assim que se limpa um chip', () => {
    for (const vazio of [null, undefined, '']) {
      expect(comParametros('/tickets', { fila: 'infra' }, { fila: vazio })).toBe('/tickets')
    }
  })

  it('volta para a primeira página ao mudar o conjunto', () => {
    const r = comParametros('/tickets', { pagina: '7', busca: 'x' }, { busca: 'y' })
    expect(r).not.toContain('pagina')
  })

  it('mas preserva a página quando é a própria página que está mudando', () => {
    const r = comParametros('/tickets', { busca: 'x' }, { pagina: '3' })
    expect(r).toContain('pagina=3')
    expect(r).toContain('busca=x')
  })

  it('escapa o que precisa ser escapado', () => {
    expect(comParametros('/tickets', {}, { busca: 'a & b' })).toContain('busca=a+%26+b')
  })

  it('sem nenhum parâmetro, o endereço fica limpo — é o que se copia e cola', () => {
    expect(comParametros('/tickets', {}, {})).toBe('/tickets')
  })
})

describe('paraIlike', () => {
  it('escapa os curingas do like', () => {
    expect(paraIlike('50%')).toBe('%50\\%%')
    expect(paraIlike('a_b')).toBe('%a\\_b%')
    expect(paraIlike('c:\\temp')).toBe('%c:\\\\temp%')
  })

  it('texto comum passa inteiro', () => {
    expect(paraIlike('servidor')).toBe('%servidor%')
  })
})
