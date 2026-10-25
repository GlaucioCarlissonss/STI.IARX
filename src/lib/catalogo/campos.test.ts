import { describe, expect, it } from 'vitest'
import {
  camposSchema,
  lerCampos,
  precoEmTexto,
  validarPreenchimento,
  type Campo,
} from './campos'

const campo = (p: Partial<Campo> = {}): Campo => ({
  chave: 'patrimonio',
  rotulo: 'Patrimônio do equipamento',
  tipo: 'texto',
  obrigatorio: false,
  ...p,
})

describe('campoSchema', () => {
  it('exige chave em formato de identificador', () => {
    /*
     * A chave atravessa o HTML (`name="campo_<chave>"`) e o JSON gravado no
     * chamado. Um espaço, um acento ou um hífen ali produzem um defeito que só
     * aparece na submissão — depois de a pessoa preencher o formulário inteiro.
     */
    for (const ruim of ['Patrimônio', 'meu campo', '2coisas', 'com-hifen', '']) {
      expect(camposSchema.safeParse([campo({ chave: ruim })]).success).toBe(false)
    }
    expect(camposSchema.safeParse([campo({ chave: 'serie_2' })]).success).toBe(true)
  })

  it('recusa tipo que a tela não sabe desenhar', () => {
    // Data e arquivo ficaram de fora de propósito: data exigiria fuso e
    // validação de passado; arquivo exigiria o Storage e a cota. Aceitá-los no
    // schema os faria aparecer como campo quebrado antes de virarem recurso.
    expect(camposSchema.safeParse([{ ...campo(), tipo: 'data' }]).success).toBe(false)
    expect(camposSchema.safeParse([{ ...campo(), tipo: 'arquivo' }]).success).toBe(false)
  })

  it('tem teto de campos e de opções', () => {
    const muitos = Array.from({ length: 21 }, (_, i) => campo({ chave: `c${i}` }))
    expect(camposSchema.safeParse(muitos).success).toBe(false)

    const muitasOpcoes = campo({
      tipo: 'escolha',
      opcoes: Array.from({ length: 41 }, (_, i) => `op${i}`),
    })
    expect(camposSchema.safeParse([muitasOpcoes]).success).toBe(false)
  })
})

describe('lerCampos', () => {
  it('descarta o campo quebrado e mantém o resto', () => {
    /*
     * O conteúdo vem de um administrador editando JSON. Recusar o serviço inteiro
     * por causa de um campo com erro de digitação o esconderia da vitrine — e
     * quem o cadastrou não teria como descobrir por quê, porque a vitrine não é
     * a tela de cadastro.
     */
    const lidos = lerCampos([
      campo({ chave: 'bom' }),
      { chave: 'Ruim!', rotulo: 'x', tipo: 'texto' },
      campo({ chave: 'tambem_bom' }),
    ])
    expect(lidos.map((c) => c.chave)).toEqual(['bom', 'tambem_bom'])
  })

  it('devolve lista vazia para o que não é lista', () => {
    expect(lerCampos(null)).toEqual([])
    expect(lerCampos('[]')).toEqual([])
    expect(lerCampos({ chave: 'x' })).toEqual([])
  })
})

describe('validarPreenchimento', () => {
  const ler = (valores: Record<string, string>) => (chave: string) => valores[chave] ?? null

  it('exige o campo obrigatório, e nomeia pelo RÓTULO', () => {
    // Quem preenche viu "Patrimônio do equipamento", não `patrimonio`. Uma
    // mensagem com a chave manda a pessoa procurar um campo que não existe na
    // tela dela.
    const r = validarPreenchimento([campo({ obrigatorio: true })], ler({}))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toBe('Preencha "Patrimônio do equipamento".')
  })

  it('aceita o opcional em branco sem inventar valor', () => {
    const r = validarPreenchimento([campo()], ler({}))
    expect(r.ok && r.valores).toEqual({})
  })

  it('converte número, inclusive com vírgula decimal', () => {
    // Quem digita em português escreve "1,5". Recusar isso seria recusar a forma
    // que a pessoa aprendeu a escrever número.
    const c = [campo({ chave: 'horas', rotulo: 'Horas', tipo: 'numero' })]
    expect(validarPreenchimento(c, ler({ horas: '1,5' }))).toEqual({
      ok: true,
      valores: { horas: 1.5 },
    })
    const ruim = validarPreenchimento(c, ler({ horas: 'duas' }))
    expect(ruim.ok).toBe(false)
    expect(!ruim.ok && ruim.erro).toContain('precisa ser um número')
  })

  it('recusa escolha fora da lista', () => {
    // A lista de opções é a definição do serviço. Aceitar fora dela deixaria o
    // pedido com um valor que a operação não sabe atender.
    const c = [
      campo({ chave: 'so', rotulo: 'Sistema', tipo: 'escolha', opcoes: ['Windows 11', 'Ubuntu'] }),
    ]
    expect(validarPreenchimento(c, ler({ so: 'Ubuntu' })).ok).toBe(true)
    const ruim = validarPreenchimento(c, ler({ so: 'MS-DOS' }))
    expect(ruim.ok).toBe(false)
    expect(!ruim.ok && ruim.erro).toContain('Sistema')
  })

  it('sim/não em branco vira falso, e não "faltou preencher"', () => {
    /*
     * Uma caixa de seleção desmarcada não envia nada no formulário — é assim que
     * o HTML funciona. Tratar a ausência como campo faltando faria todo pedido
     * com um "é urgente?" desmarcado ser recusado.
     */
    const c = [campo({ chave: 'urgente', rotulo: 'É urgente?', tipo: 'simnao', obrigatorio: true })]
    expect(validarPreenchimento(c, ler({}))).toEqual({ ok: true, valores: { urgente: false } })
    expect(validarPreenchimento(c, ler({ urgente: 'on' }))).toEqual({
      ok: true,
      valores: { urgente: true },
    })
  })

  it('recusa texto longo demais', () => {
    const c = [campo({ chave: 'obs', rotulo: 'Observação' })]
    const r = validarPreenchimento(c, ler({ obs: 'x'.repeat(2001) }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toContain('Observação')
  })
})

describe('precoEmTexto', () => {
  it('distingue as três ausências de cobrança', () => {
    /*
     * As três frases significam coisas diferentes, e misturá-las custa dinheiro:
     *
     *   · incluído no contrato — o cliente já paga no pacote;
     *   · sem custo            — é de graça para todo mundo;
     *   · sob consulta         — não há preço publicado.
     *
     * Tratar nulo como zero faria o terceiro aparecer como cortesia, e a
     * primeira cobrança viraria uma discussão.
     */
    expect(precoEmTexto(null, true, null)).toBe('Incluído no contrato')
    expect(precoEmTexto(0, true, null)).toBe('Incluído no contrato')
    expect(precoEmTexto(0, false, null)).toBe('Sem custo')
    expect(precoEmTexto(null, false, null)).toBe('Sob consulta')
  })

  it('escreve em reais e acrescenta a unidade', () => {
    expect(precoEmTexto(180, false, 'unidade')).toContain('180,00')
    expect(precoEmTexto(180, false, 'hora')).toContain('por hora')
    expect(precoEmTexto(180, false, 'mes')).toContain('por mês')
    expect(precoEmTexto(180, false, 'usuario')).toContain('por usuário')
  })

  it('ignora unidade desconhecida em vez de imprimi-la crua', () => {
    // Unidade nova no banco e ainda não traduzida aqui apareceria como
    // "R$ 180,00 litro" se o texto fosse concatenado direto.
    expect(precoEmTexto(180, false, 'litro')).toBe(
      (180).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    )
  })
})
