/**
 * A geometria da série do resultado.
 *
 * Separada do componente pelo mesmo motivo que `trechosDaLinha` é separada do
 * gráfico de horas: a aritmética de um gráfico é testável, o SVG não é. Um erro
 * de escala não quebra nada — desenha errado, e desenhar errado é exatamente o
 * que ninguém percebe olhando.
 */

/** Um retângulo de barra, em coordenadas do `viewBox`. */
export interface Barra {
  x: number
  y: number
  largura: number
  altura: number
}

/**
 * O teto do eixo, arredondado para cima até um número redondo.
 *
 * Sem isto, o topo do gráfico seria o maior valor da série, e a referência
 * escrita ao lado do eixo seria algo como "R$ 18.743,29" — um número que não
 * ajuda ninguém a estimar a barra do meio. Arredondar para 1, 2 ou 5 vezes uma
 * potência de dez dá um teto que a pessoa consegue dividir de cabeça.
 *
 * Série toda zerada devolve 1: um teto zero faria toda altura ser `0/0`.
 */
export function tetoDaEscala(valores: readonly number[]): number {
  const maximo = valores.reduce((m, v) => (v > m ? v : m), 0)
  if (maximo <= 0) return 1

  const potencia = 10 ** Math.floor(Math.log10(maximo))
  for (const passo of [1, 2, 5, 10]) {
    if (maximo <= passo * potencia) return passo * potencia
  }
  return 10 * potencia
}

/**
 * As barras de uma série, da esquerda para a direita.
 *
 * A folga entre barras é proporcional à largura disponível, e não fixa: com
 * doze meses numa tela estreita, uma folga fixa de 6px comeria metade da barra.
 */
export function barrasDaSerie(
  valores: readonly number[],
  largura: number,
  altura: number,
  teto = tetoDaEscala(valores),
): Barra[] {
  if (valores.length === 0) return []
  const passo = largura / valores.length
  const folga = Math.min(passo * 0.25, 8)
  const larguraDaBarra = Math.max(passo - folga, 1)

  return valores.map((v, i) => {
    /* Valor negativo não existe em custo lançado, mas um dado estranho não pode
       virar uma barra crescendo para fora do quadro. */
    const alturaDaBarra = teto > 0 ? (Math.max(0, v) / teto) * altura : 0
    return {
      x: i * passo + folga / 2,
      largura: larguraDaBarra,
      altura: alturaDaBarra,
      y: altura - alturaDaBarra,
    }
  })
}

/** Um ponto medido da linha, para o círculo que o marca. */
export interface Ponto {
  x: number
  y: number
  indice: number
  valor: number
}

/**
 * Os pontos medidos de uma linha, ignorando os meses sem medida.
 *
 * Eles existem por um caso concreto: `trechosDaLinha` descarta trecho com um
 * ponto só, então um único mês medido no meio de onze vazios **desapareceria**
 * do gráfico. É o mês que mais importa olhar — o primeiro em que passou a haver
 * medida.
 */
export function pontosDaLinha(
  valores: readonly (number | null)[],
  largura: number,
  altura: number,
  maximo = 100,
): Ponto[] {
  if (valores.length < 2) return []
  const passo = largura / (valores.length - 1)
  return valores.flatMap((v, i) =>
    v === null
      ? []
      : [
          {
            x: i * passo,
            y: altura - (Math.max(0, Math.min(maximo, v)) / maximo) * altura,
            indice: i,
            valor: v,
          },
        ],
  )
}

/**
 * A conclusão da série, em texto.
 *
 * É o que vai no `aria-label` do SVG: quem usa leitor de tela recebe a mesma
 * leitura que quem olha, e não "gráfico". Também é o que se lê em voz alta numa
 * reunião, e por isso diz o período e a direção, não os doze valores.
 */
export function lerASerie(
  rotulos: readonly string[],
  gasto: readonly number[],
  conformidade: readonly (number | null)[],
): string {
  if (rotulos.length === 0) return 'Sem meses na série.'

  const primeiro = rotulos[0]
  const ultimo = rotulos[rotulos.length - 1]
  const medidos = conformidade.filter((v): v is number => v !== null)

  const partes = [
    `Série de ${rotulos.length} meses, de ${primeiro} a ${ultimo}.`,
    `Gasto entre ${Math.min(...gasto).toFixed(2)} e ${Math.max(...gasto).toFixed(2)} reais por mês.`,
  ]
  partes.push(
    medidos.length === 0
      ? 'Nenhum mês com chamado coberto por acordo, então não há conformidade a comparar.'
      : `Conformidade medida em ${medidos.length} dos ${rotulos.length} meses, entre ${Math.min(
          ...medidos,
        )
          .toFixed(1)
          .replace('.', ',')}% e ${Math.max(...medidos).toFixed(1).replace('.', ',')}%.`,
  )
  return partes.join(' ')
}
