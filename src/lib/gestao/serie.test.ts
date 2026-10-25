import { describe, expect, it } from 'vitest'
import { trechosDaLinha } from '@/lib/agent/metricas'
import { barrasDaSerie, lerASerie, pontosDaLinha, tetoDaEscala } from './serie'

/**
 * O que estes testes protegem
 * ---------------------------
 * Um gráfico errado não quebra nada: ele desenha. E desenhar errado é
 * justamente o que ninguém percebe olhando — a barra parece plausível, a linha
 * parece plausível, e a conclusão que a pessoa tira é falsa.
 *
 * Três erros concretos:
 *  - a barra que estoura o quadro porque o teto da escala era zero;
 *  - o mês sem medida ligado por uma reta ao seguinte, que se lê como
 *    "ficou constante";
 *  - o único mês medido da série sumindo do gráfico.
 */

describe('tetoDaEscala', () => {
  it('arredonda para um número que dá para dividir de cabeça', () => {
    expect(tetoDaEscala([1874.29])).toBe(2000)
    expect(tetoDaEscala([120, 340])).toBe(500)
    expect(tetoDaEscala([9, 3])).toBe(10)
  })

  it('série zerada devolve 1, e não 0', () => {
    // Teto zero faria toda altura virar 0/0 — e `NaN` num atributo de SVG não
    // desenha nada, nem avisa.
    expect(tetoDaEscala([0, 0, 0])).toBe(1)
    expect(tetoDaEscala([])).toBe(1)
  })

  it('um valor exatamente no degrau não sobe para o próximo', () => {
    expect(tetoDaEscala([500])).toBe(500)
    expect(tetoDaEscala([1000])).toBe(1000)
  })
})

describe('barrasDaSerie', () => {
  it('a barra do maior valor encosta no topo, e as outras são proporcionais', () => {
    const b = barrasDaSerie([1000, 500, 0], 300, 100, 1000)
    expect(b[0]!.altura).toBe(100)
    expect(b[1]!.altura).toBe(50)
    expect(b[2]!.altura).toBe(0)
    expect(b[0]!.y).toBe(0)
  })

  it('nenhuma barra sai do quadro', () => {
    for (const barra of barrasDaSerie([10, 20, 30], 300, 100)) {
      expect(barra.y).toBeGreaterThanOrEqual(0)
      expect(barra.y + barra.altura).toBeLessThanOrEqual(100.001)
      expect(barra.x + barra.largura).toBeLessThanOrEqual(300.001)
    }
  })

  it('valor negativo não cresce para fora do quadro', () => {
    // Custo lançado não é negativo, mas um dado estranho não pode virar um
    // retângulo invertido subindo pela tela.
    const [b] = barrasDaSerie([-500], 100, 100, 1000)
    expect(b!.altura).toBe(0)
  })

  it('a folga encolhe junto com o espaço', () => {
    const largas = barrasDaSerie([1, 1], 800, 100)
    const estreitas = barrasDaSerie(Array(12).fill(1), 240, 100)
    expect(largas[0]!.largura).toBeGreaterThan(estreitas[0]!.largura)
    expect(estreitas[0]!.largura).toBeGreaterThan(0)
  })
})

describe('a linha da conformidade', () => {
  it('mês sem medida vira BURACO, não reta', () => {
    /*
     * Uma reta sobre o mês vazio seria lida como "a conformidade ficou
     * constante" — o contrário de "não houve chamado com acordo para medir".
     */
    const trechos = trechosDaLinha([90, null, 80, 85], 300, 100)
    expect(trechos).toHaveLength(1)
    expect(trechos[0]).not.toContain('M0.0')
  })

  it('e o único mês medido da série continua aparecendo', () => {
    // `trechosDaLinha` descarta trecho de um ponto só: sem o círculo, o primeiro
    // mês com medida — o mais importante de olhar — sumiria.
    const valores = [null, null, 72, null]
    expect(trechosDaLinha(valores, 300, 100)).toHaveLength(0)
    const pontos = pontosDaLinha(valores, 300, 100)
    expect(pontos).toHaveLength(1)
    expect(pontos[0]!.indice).toBe(2)
    expect(pontos[0]!.valor).toBe(72)
  })

  it('100% encosta no topo e 0% no chão', () => {
    const [cheio, vazio] = pontosDaLinha([100, 0], 300, 100)
    expect(cheio!.y).toBe(0)
    expect(vazio!.y).toBe(100)
  })
})

describe('lerASerie', () => {
  it('diz o período e a faixa, e não os doze valores', () => {
    const texto = lerASerie(['01/2026', '02/2026'], [100, 200], [90, 80])
    expect(texto).toContain('2 meses')
    expect(texto).toContain('01/2026')
    expect(texto).toContain('02/2026')
    expect(texto).toContain('80,0%')
  })

  it('sem conformidade medida, DIZ que não há o que comparar', () => {
    // Em vez de calar: "não houve medida" é uma informação, e quem usa leitor
    // de tela precisa dela tanto quanto quem vê a linha interrompida.
    const texto = lerASerie(['01/2026', '02/2026'], [10, 20], [null, null])
    expect(texto).toContain('Nenhum mês com chamado coberto')
  })
})
