import { describe, expect, it, vi } from 'vitest'
import { mensagemDeErro, NAO_AFETADO } from './erros'

/**
 * A regra que este arquivo protege está no briefing, em uma linha: "mensagens de
 * erro claras e acionáveis, **sem expor detalhes técnicos internos**".
 *
 * Ela é fácil de escrever e fácil de perder. Um `default: return error.message`
 * acrescentado numa pressa devolve a frase do Postgres inteira — com nome de
 * tabela, de coluna e de constraint — para quem só queria salvar um cadastro. E
 * não quebra nada: a tela continua funcionando, só passa a contar coisa demais.
 */

// `mensagemDeErro` registra o texto cru no log do servidor. Nos testes isso é
// ruído, e silenciá-lo aqui também prova que o registro acontece.
const silenciar = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('mensagemDeErro', () => {
  it('usa a frase de quem chama na chave duplicada — ela diz ONDE está o conflito', () => {
    expect(
      mensagemDeErro({ code: '23505', message: 'duplicate key' }, 'Já existe um ativo com este patrimônio.'),
    ).toBe('Já existe um ativo com este patrimônio.')
  })

  it('cai num genérico em português quando quem chama não deu frase', () => {
    expect(mensagemDeErro({ code: '23505', message: 'duplicate key value' })).toBe(
      'Já existe um registro com estes dados.',
    )
  })

  it('explica o vínculo na violação de chave estrangeira', () => {
    const m = mensagemDeErro({ code: '23503', message: 'violates foreign key constraint "fk_x"' })
    expect(m).toContain('vinculado a outro cadastro')
    expect(m).not.toContain('fk_x')
  })

  it('trata negação de privilégio como o mesmo caso de RLS negando', () => {
    expect(mensagemDeErro({ code: '42501', message: 'permission denied for table tickets' })).toBe(
      NAO_AFETADO,
    )
  })

  describe('23514 — o código que as nossas triggers e o Postgres dividem', () => {
    it('repassa a mensagem quando ela foi escrita por uma trigger nossa', () => {
      /* Dezessete triggers desta base levantam `check_violation` de propósito,
         já em português e já acionáveis. Engolir essas seria perder a única
         frase que explica a regra violada. */
      expect(
        mensagemDeErro({ code: '23514', message: 'Área não pertence à filial do ativo' }),
      ).toBe('Área não pertence à filial do ativo')
    })

    it('NÃO repassa a frase do Postgres, que carrega tabela e constraint', () => {
      const log = silenciar()
      const m = mensagemDeErro({
        code: '23514',
        message: 'new row for relation "clients" violates check constraint "clients_color_hex"',
      })
      expect(m).not.toContain('clients')
      expect(m).not.toContain('constraint')
      expect(m).toContain('Revise os campos')
      expect(log).toHaveBeenCalled() // o texto cru foi para o log, não se perdeu
      log.mockRestore()
    })
  })

  describe('o caminho padrão — o que acontece com o erro que ninguém previu', () => {
    it('não devolve a mensagem crua', () => {
      const log = silenciar()
      const m = mensagemDeErro({ code: '08006', message: 'could not connect to server: ECONNREFUSED' })
      expect(m).not.toContain('ECONNREFUSED')
      expect(m).not.toContain('server')
      expect(log).toHaveBeenCalled()
      log.mockRestore()
    })

    it('carrega o SQLSTATE, que é o que o suporte usa para achar a linha no log', () => {
      const log = silenciar()
      expect(mensagemDeErro({ code: '08006', message: 'qualquer coisa' })).toContain('código 08006')
      log.mockRestore()
    })

    it('funciona sem código nenhum — erro de rede chega assim', () => {
      const log = silenciar()
      const m = mensagemDeErro({ message: 'TypeError: fetch failed' })
      expect(m).not.toContain('fetch')
      expect(m).not.toContain('código')
      log.mockRestore()
    })
  })

  it('nenhuma mensagem devolvida contém jargão de banco', () => {
    /*
     * A varredura existe porque cada caso acima testa um ramo, e um ramo novo
     * entra sem teste. Esta roda sobre todos os códigos que a aplicação já viu.
     */
    const log = silenciar()
    const codigos = ['23505', '23503', '23502', '23514', '2BP01', '42501', '08006', undefined]
    const proibido = /relation|constraint|column|violates|null value|ERROR:|SQLSTATE|select |insert /i
    for (const code of codigos) {
      const m = mensagemDeErro({
        code,
        message: 'ERROR: null value in column "nome" of relation "clients" violates not-null constraint',
      })
      expect(m, `código ${code}`).not.toMatch(proibido)
    }
    log.mockRestore()
  })
})
