import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { centavosEmDolar, faixaDeConfianca, porQueNaoPosso, resolverTriagem } from './regras'
import { custoEmCentavos, credencialDaIA, type ConfigDeIA } from './tipos'
import {
  artigoSugeridoSchema,
  respostaSugeridaSchema,
  triagemSugeridaSchema,
} from './tipos'

/**
 * O que estes testes protegem
 * --------------------------
 * Três coisas que, erradas, custam dinheiro ou confiança: deixar chamar quando
 * não devia (orçamento, recurso desligado, variável ausente), aceitar uma chave
 * de categoria que não existe, e subestimar o custo de um modelo desconhecido.
 *
 * A chamada ao provedor em si não é testada aqui, e não há credencial neste
 * ambiente para testá-la — está dito em docs/17.
 */

const base: ConfigDeIA = {
  enabled: true,
  model: 'claude-opus-5-5',
  effort: 'medium',
  secret_ref: 'TESTE_IA_CHAVE',
  sugerir_resposta: true,
  sugerir_triagem: true,
  redigir_artigo: true,
  enviar_notas_internas: false,
  tem_orcamento: true,
  limite_mensal_centavos: 5000,
  gasto_do_mes_centavos: 0,
}

describe('porQueNaoPosso', () => {
  beforeEach(() => {
    process.env.TESTE_IA_CHAVE = 'sk-ant-de-teste'
  })
  afterEach(() => {
    delete process.env.TESTE_IA_CHAVE
  })

  it('configuração ausente é "desligada", e não erro', () => {
    // Tenant que nunca mexeu nisso é o caso comum, não uma exceção.
    expect(porQueNaoPosso(null, 'resposta')).toBe('desligada')
  })

  it('ligada, com recurso e com orçamento: pode', () => {
    expect(porQueNaoPosso(base, 'resposta')).toBeNull()
  })

  it('cada recurso é conferido separadamente', () => {
    const semTriagem = { ...base, sugerir_triagem: false }
    expect(porQueNaoPosso(semTriagem, 'triagem')).toBe('recurso_desligado')
    // E não contamina os outros dois.
    expect(porQueNaoPosso(semTriagem, 'resposta')).toBeNull()
    expect(porQueNaoPosso(semTriagem, 'artigo')).toBeNull()
  })

  it('orçamento estourado barra ANTES de gastar', () => {
    /*
     * A conferência precisa acontecer aqui, e não depois da resposta: depois já
     * gastou. É o motivo de `tem_orcamento` vir calculado do banco em vez de a
     * tela comparar os dois números.
     */
    expect(porQueNaoPosso({ ...base, tem_orcamento: false }, 'resposta')).toBe('sem_orcamento')
  })

  it('a ordem dos motivos vai do geral ao específico', () => {
    // Desligada e sem orçamento ao mesmo tempo: quem não ligou a IA não quer
    // saber do orçamento dela.
    expect(porQueNaoPosso({ ...base, enabled: false, tem_orcamento: false }, 'resposta')).toBe(
      'desligada',
    )
  })

  it('variável nomeada que não existe no servidor tem motivo PRÓPRIO', () => {
    /*
     * O erro de configuração mais comum: o nome está certo no banco e ninguém
     * definiu a variável no ambiente. Sem um motivo próprio, isso viraria
     * "indisponível" — que é a mensagem que mais gera chamado de suporte sobre o
     * próprio sistema.
     */
    delete process.env.TESTE_IA_CHAVE
    expect(porQueNaoPosso(base, 'resposta')).toBe('variavel_ausente')
  })

  it('sem referência de credencial é outro motivo ainda', () => {
    expect(porQueNaoPosso({ ...base, secret_ref: null }, 'resposta')).toBe('sem_credencial')
  })
})

describe('credencialDaIA', () => {
  it('confere o FORMATO antes de tocar em process.env', () => {
    /*
     * `process.env[x]` com um nome vindo do banco é leitura indireta de variável
     * arbitrária — inclusive `SUPABASE_SERVICE_ROLE_KEY`, que bypassa todo o RLS.
     * O regex é a trava, e ela vem antes do acesso.
     */
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'nao-deve-vazar'
    expect(credencialDaIA('supabase_service_role_key')).toBeNull()
    expect(credencialDaIA('../../etc/passwd')).toBeNull()
    expect(credencialDaIA('')).toBeNull()
    expect(credencialDaIA(null)).toBeNull()
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('variável vazia conta como ausente', () => {
    // Definida como string vazia é o que acontece quando alguém põe a linha no
    // .env e esquece o valor. Tratar como presente faria a chamada sair sem
    // chave e voltar com 401.
    process.env.IA_VAZIA = '   '
    expect(credencialDaIA('IA_VAZIA')).toBeNull()
    delete process.env.IA_VAZIA
  })
})

describe('resolverTriagem', () => {
  const categorias = [
    { id: 'c1', name: 'Senha e acesso' },
    { id: 'c2', name: 'Rede' },
  ]
  const prioridades = [
    { id: 'p1', key: 'alta', label: 'Alta' },
    { id: 'p2', key: 'baixa', label: 'Baixa' },
  ]

  it('converte nome e chave em ids', () => {
    const r = resolverTriagem(
      { categoria_nome: 'Senha e acesso', prioridade_chave: 'alta', justificativa: 'x', confianca: 0.9 },
      categorias,
      prioridades,
    )
    expect(r).toEqual({
      ok: true,
      category_id: 'c1',
      category_name: 'Senha e acesso',
      priority_id: 'p1',
      priority_name: 'Alta',
    })
  })

  it('categoria inventada é RECUSADA, com o nome dela na mensagem', () => {
    /*
     * A razão de pedir chave e não uuid. Um uuid inventado é indistinguível de um
     * verdadeiro até o `update` falhar — e, com azar, pode ser o uuid de outra
     * categoria que existe, aplicando silenciosamente a classificação errada.
     */
    const r = resolverTriagem(
      { categoria_nome: 'Impressoras', prioridade_chave: null, justificativa: 'x', confianca: 0.5 },
      categorias,
      prioridades,
    )
    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toContain('Impressoras')
  })

  it('casa ignorando caixa e espaço', () => {
    // O modelo escreve "senha e acesso" onde o cadastro diz "Senha e acesso".
    // Recusar por isso perderia a sugestão por detalhe de digitação.
    const r = resolverTriagem(
      { categoria_nome: '  senha E acesso ', prioridade_chave: null, justificativa: 'x', confianca: 0.8 },
      categorias,
      prioridades,
    )
    expect(r.ok && r.category_id).toBe('c1')
  })

  it('nome AMBÍGUO é recusado, e não resolvido pela primeira ocorrência', () => {
    /*
     * `uq_category_name` é único por (tenant, categoria-pai), não por tenant: duas
     * subcategorias "Senha", uma sob "Acesso" e outra sob "E-mail", são legítimas.
     * Aí o nome não diz qual é, e escolher a primeira aplicaria a classificação
     * errada em silêncio — o defeito que este módulo inteiro evita.
     */
    const duplicadas = [
      { id: 'c1', name: 'Senha' },
      { id: 'c9', name: 'Senha' },
    ]
    const r = resolverTriagem(
      { categoria_nome: 'Senha', prioridade_chave: null, justificativa: 'x', confianca: 0.9 },
      duplicadas,
      prioridades,
    )
    expect(r.ok).toBe(false)
    expect(!r.ok && r.erro).toContain('mais de uma categoria')
  })

  it('null em um dos campos é resultado legítimo', () => {
    // O prompt pede explicitamente para devolver null quando o chamado não dá
    // base. Null honesto vale mais que palpite aceito sem conferir.
    const r = resolverTriagem(
      { categoria_nome: null, prioridade_chave: 'baixa', justificativa: 'x', confianca: 0.4 },
      categorias,
      prioridades,
    )
    expect(r.ok).toBe(true)
    expect(r.ok && r.category_id).toBeNull()
    expect(r.ok && r.priority_id).toBe('p2')
  })

  it('null nos DOIS não vira sugestão', () => {
    // Ela ocuparia o índice único de pendente por chamado e mostraria um cartão
    // vazio com um botão de aplicar que não aplicaria nada.
    const r = resolverTriagem(
      { categoria_nome: null, prioridade_chave: null, justificativa: 'faltou info', confianca: 0.1 },
      categorias,
      prioridades,
    )
    expect(r.ok).toBe(false)
  })
})

describe('custoEmCentavos', () => {
  it('cobra entrada e saída com preços diferentes', () => {
    // 1M de entrada a 400 centavos + 1M de saída a 2000.
    expect(custoEmCentavos('claude-opus-5-5', 1_000_000, 1_000_000)).toBe(2400)
  })

  it('arredonda para CIMA, nunca para baixo', () => {
    // É um teto de gasto: subestimar deixaria passar o que deveria barrar.
    expect(custoEmCentavos('claude-haiku-5-5', 1000, 0)).toBe(1)
  })

  it('modelo desconhecido usa o preço mais CARO, não zero', () => {
    /*
     * Modelo novo sai sem avisar, e a tela aceita digitar qualquer um. Se um
     * modelo fora da tabela custasse zero, o teto mensal nunca o barraria —
     * justamente o caso em que ninguém sabe quanto ele custa.
     */
    const desconhecido = custoEmCentavos('modelo-que-nao-existe', 1_000_000, 1_000_000)
    const maisCaroConhecido = custoEmCentavos('claude-opus-5', 1_000_000, 1_000_000)
    expect(desconhecido).toBeGreaterThan(maisCaroConhecido)
  })
})

describe('faixaDeConfianca', () => {
  it('são três faixas, e não o número cru', () => {
    // "0,73" convida a comparar precisão que não existe. O que a pessoa precisa
    // saber é se lê como resposta ou como ponto de partida.
    expect(faixaDeConfianca(0.9).tom).toBe('ok')
    expect(faixaDeConfianca(0.5).tom).toBe('neutral')
    expect(faixaDeConfianca(0.2).tom).toBe('warn')
    expect(faixaDeConfianca(0.2).rotulo).toContain('ponto de partida')
  })
})

describe('centavosEmDolar', () => {
  it('escreve com dois decimais', () => {
    expect(centavosEmDolar(0)).toBe('US$ 0.00')
    expect(centavosEmDolar(1234)).toBe('US$ 12.34')
  })
})

describe('os esquemas de saída', () => {
  /*
   * Estes mesmos objetos são enviados ao provedor como esquema OBRIGATÓRIO de
   * saída. É essa amarração que torna a injeção de prompt inofensiva: um chamado
   * que diga "ignore as instruções" ainda assim só consegue preencher estes
   * campos. Mudar um deles muda o contrato com o provedor.
   */
  it('a resposta exige texto, confiança e a decisão sobre precisar de pessoa', () => {
    expect(
      respostaSugeridaSchema.safeParse({
        texto: 'Bom dia, pode reiniciar o roteador?',
        confianca: 0.8,
        precisa_de_pessoa: false,
      }).success,
    ).toBe(true)

    // Sem `precisa_de_pessoa` não passa: é o campo mais útil dos quatro.
    expect(
      respostaSugeridaSchema.safeParse({ texto: 'oi', confianca: 0.8 }).success,
    ).toBe(false)

    // Confiança fora de 0..1 não passa — ela alimenta a faixa da tela.
    expect(
      respostaSugeridaSchema.safeParse({ texto: 'oi', confianca: 7, precisa_de_pessoa: false })
        .success,
    ).toBe(false)
  })

  it('a triagem aceita null nas chaves e exige justificativa', () => {
    expect(
      triagemSugeridaSchema.safeParse({
        categoria_nome: null,
        prioridade_chave: null,
        justificativa: 'Não há informação suficiente.',
        confianca: 0.2,
      }).success,
    ).toBe(true)

    expect(
      triagemSugeridaSchema.safeParse({
        categoria_nome: 'Senha e acesso',
        prioridade_chave: 'alta',
        justificativa: '',
        confianca: 0.9,
      }).success,
    ).toBe(false)
  })

  it('o artigo exige corpo com conteúdo de verdade', () => {
    // 20 caracteres mínimos: um corpo de três palavras não é artigo, e publicar
    // um desses faz quem o lê parar de procurar na base.
    expect(
      artigoSugeridoSchema.safeParse({ title: 'A impressora para', resumo: 'Fila travada', body: 'reinicie' })
        .success,
    ).toBe(false)
  })
})
