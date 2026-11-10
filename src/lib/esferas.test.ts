import { describe, expect, it } from 'vitest'
import { esferasEmUso, lerEsferas, lerFoco, type Esfera } from './esferas'

/*
 * A esfera decide o que EXISTE no menu de uma empresa, e o foco decide o que
 * aparece agora. As duas leituras vêm de fora — banco e cookie —, e são
 * exatamente os lugares onde um valor estranho não dá erro: dá menu vazio, que
 * é indistinguível de "o sistema perdeu minhas telas".
 */

describe('lerEsferas', () => {
  it('mantém as esferas conhecidas, na ordem em que vieram', () => {
    expect(lerEsferas(['rental', 'management'])).toEqual(['rental', 'management'])
  })

  it('descarta valor desconhecido em vez de derrubar a página', () => {
    expect(lerEsferas(['management', 'rentaI', 42, null])).toEqual(['management'])
  })

  it('tira a duplicata — ela é inofensiva na leitura, mas confunde a contagem', () => {
    expect(lerEsferas(['rental', 'rental'])).toEqual(['rental'])
  })

  it('lista vazia cai em gestão, que é o padrão da coluna', () => {
    // Uma sessão sem esfera nenhuma não veria tela nenhuma — nem a de
    // preferências, que é onde o engano se desfaz.
    expect(lerEsferas([])).toEqual(['management'])
    expect(lerEsferas(null)).toEqual(['management'])
  })
})

describe('lerFoco', () => {
  const duas: Esfera[] = ['management', 'rental']

  it('aceita o foco que a empresa tem', () => {
    expect(lerFoco('rental', duas)).toBe('rental')
  })

  it('ignora cookie que aponta para esfera desligada depois', () => {
    // O caso real: a empresa tinha as duas, alguém focou locação, e depois a
    // esfera foi desligada. Sem isto, o menu ficaria vazio sem explicação.
    expect(lerFoco('rental', ['management'])).toBeNull()
  })

  it('ignora cookie com valor inventado', () => {
    expect(lerFoco('tudo', duas)).toBeNull()
  })

  it('não vale com uma esfera só: focar o que já é único não encurta nada', () => {
    expect(lerFoco('management', ['management'])).toBeNull()
  })

  it('cookie ausente é "as duas"', () => {
    expect(lerFoco(undefined, duas)).toBeNull()
  })
})

describe('esferasEmUso', () => {
  it('sem foco, valem todas as da empresa', () => {
    expect(esferasEmUso(['management', 'rental'], null)).toEqual(['management', 'rental'])
  })

  it('com foco, vale só uma — e é só isso que o foco faz', () => {
    expect(esferasEmUso(['management', 'rental'], 'rental')).toEqual(['rental'])
  })
})
