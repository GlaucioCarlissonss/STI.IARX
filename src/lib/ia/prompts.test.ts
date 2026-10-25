import { describe, expect, it } from 'vitest'
import {
  SISTEMA_DA_RESPOSTA,
  SISTEMA_DA_TRIAGEM,
  SISTEMA_DO_ARTIGO,
  perguntaDaResposta,
  perguntaDaTriagem,
  perguntaDoArtigo,
} from './prompts'
import type { ContextoDoChamado } from './tipos'

/**
 * O que um teste de prompt pode e não pode provar
 * -----------------------------------------------
 * Não dá para provar aqui que a resposta será boa — isso exige o modelo, uma
 * credencial e um conjunto de avaliação, e nada disso existe neste ambiente
 * (docs/17 diz isso em voz alta).
 *
 * O que dá para provar é o que o prompt LEVA, que é onde moram os defeitos
 * caros: nota interna que não deveria sair, histórico inteiro de um chamado de
 * oitenta comentários (que gasta o orçamento do mês numa chamada), e o conteúdo
 * de terceiro sem a marcação que diz ao modelo que aquilo é dado.
 */

const ctx: ContextoDoChamado = {
  title: 'A impressora da recepção parou',
  description: 'Desde cedo aparece "fila travada".',
  category_name: 'Impressoras',
  priority_name: 'Média',
  status: 'open',
  cliente: 'Transportadora Alfa',
  comentarios: [
    { autor: 'equipe ou cliente', texto: 'Reiniciei e não resolveu.' },
    { autor: 'equipe ou cliente', texto: 'Vou passar aí depois do almoço.' },
  ],
}

describe('o bloco do chamado', () => {
  it('vem cercado por marcadores, e diz que é conteúdo de terceiro', () => {
    /*
     * O prompt pede e não obriga — a trava de verdade é o esquema de saída. Mas a
     * marcação é barata e muda o comportamento do modelo diante de um chamado que
     * diga "ignore as instruções anteriores".
     */
    const p = perguntaDoArtigo(ctx)
    expect(p).toContain('<<<CONTEUDO_DO_CHAMADO')
    expect(p).toContain('FIM_DO_CONTEUDO_DO_CHAMADO>>>')
    expect(SISTEMA_DO_ARTIGO).toContain('escrito por terceiros')
    expect(SISTEMA_DA_RESPOSTA).toContain('escrito por terceiros')
    expect(SISTEMA_DA_TRIAGEM).toContain('escrito por terceiros')
  })

  it('leva título, descrição, situação, categoria, prioridade e empresa', () => {
    const p = perguntaDoArtigo(ctx)
    for (const pedaco of [
      'A impressora da recepção parou',
      'fila travada',
      'Impressoras',
      'Média',
      'Transportadora Alfa',
    ]) {
      expect(p).toContain(pedaco)
    }
  })

  it('corta o histórico pelo COMEÇO, não pelo fim', () => {
    /*
     * Num chamado com oitenta comentários a informação útil está no fim: o começo
     * é a pergunta inicial, que já foi na descrição. Cortar pelo fim mandaria a
     * parte menos útil e gastaria o orçamento nela.
     */
    const longo: ContextoDoChamado = {
      ...ctx,
      comentarios: Array.from({ length: 40 }, (_, i) => ({
        autor: 'equipe ou cliente',
        texto: `comentario-${i}`,
      })),
    }
    const p = perguntaDoArtigo(longo)
    expect(p).toContain('comentario-39')
    expect(p).not.toContain('comentario-0\n')
    // E diz quantos ficaram de fora, para quem lê a sugestão saber.
    expect(p).toContain('comentário(s) mais antigo(s) omitido(s)')
  })

  it('a triagem leva MENOS histórico que os outros dois', () => {
    /*
     * Classificar não precisa da conversa inteira: título, descrição e as
     * primeiras trocas bastam. Mandar o resto é pagar por token que não muda a
     * resposta — e a triagem é o recurso que mais se pede, uma vez por chamado
     * novo.
     */
    const longo: ContextoDoChamado = {
      ...ctx,
      comentarios: Array.from({ length: 30 }, (_, i) => ({
        autor: 'equipe ou cliente',
        texto: `comentario-${i}`,
      })),
    }
    const daTriagem = perguntaDaTriagem(longo, [], [])
    const doArtigo = perguntaDoArtigo(longo)
    expect(daTriagem.length).toBeLessThan(doArtigo.length)
    expect(daTriagem).toContain('comentario-29')
    expect(daTriagem).not.toContain('comentario-20')
  })

  it('chamado sem descrição não vira prompt com "null"', () => {
    const vazio = { ...ctx, description: null, category_name: null, priority_name: null, cliente: null }
    const p = perguntaDoArtigo(vazio)
    expect(p).not.toContain('null')
    expect(p).toContain('(sem descrição)')
    expect(p).toContain('(sem categoria)')
  })
})

describe('a pergunta da resposta', () => {
  it('leva os artigos da base, com título e resumo', () => {
    const p = perguntaDaResposta(ctx, [
      { title: 'Como destravar a fila de impressão', resumo: 'Parar o spooler e limpar a pasta.' },
    ])
    expect(p).toContain('Como destravar a fila de impressão')
    expect(p).toContain('Parar o spooler')
  })

  it('sem artigo relacionado, diz isso em vez de mandar lista vazia', () => {
    // Uma lista vazia sem explicação faria o modelo inventar artigo para citar.
    const p = perguntaDaResposta(ctx, [])
    expect(p).toContain('nenhum artigo da base parece relacionado')
  })

  it('o sistema proíbe inventar artigo', () => {
    expect(SISTEMA_DA_RESPOSTA).toContain('Não invente artigo')
  })
})

describe('a pergunta da triagem', () => {
  it('leva o que está disponível, que é contra o que a resposta é conferida', () => {
    const p = perguntaDaTriagem(
      ctx,
      [{ name: 'Impressoras' }],
      [{ key: 'media', label: 'Média' }],
    )
    expect(p).toContain('- Impressoras')
    expect(p).toContain('media: Média')
  })

  it('cadastro vazio não vira lista em branco silenciosa', () => {
    const p = perguntaDaTriagem(ctx, [], [])
    expect(p).toContain('(nenhuma cadastrada)')
  })

  it('o sistema manda ignorar o tom de quem escreveu', () => {
    // "URGENTE!!!" num pedido de mouse continua sendo baixa. É o erro de triagem
    // mais comum, humana ou não.
    expect(SISTEMA_DA_TRIAGEM).toContain('não o tom de quem escreveu')
  })
})

describe('o sistema do artigo', () => {
  it('proíbe markdown, porque a base não renderiza', () => {
    expect(SISTEMA_DO_ARTIGO).toContain('TEXTO SIMPLES')
    expect(SISTEMA_DO_ARTIGO).toContain('markdown')
  })

  it('manda tirar o que identifica o chamado de origem', () => {
    // O artigo é público para a base inteira — inclusive para solicitante de
    // empresa-cliente.
    expect(SISTEMA_DO_ARTIGO).toContain('nome de pessoa')
  })
})
