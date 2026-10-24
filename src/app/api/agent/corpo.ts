import { NextResponse } from 'next/server'

/**
 * Leitura de corpo com teto de tamanho.
 *
 * ## Por que isto precisa existir
 *
 * O agente roda em computador de cliente, fora do alcance de quem opera o
 * servidor. Um token de máquina vazado, um agente com defeito ou uma estação com
 * 40 mil pacotes instalados mandam um corpo grande — e `request.json()` lê o
 * corpo inteiro na memória antes de qualquer validação. O schema do zod recusaria
 * depois, com a memória já gasta.
 *
 * Conferir o `Content-Length` não basta sozinho: ele é um cabeçalho, quem envia
 * escolhe o valor, e uma requisição com `Transfer-Encoding: chunked` não tem
 * nenhum. Por isso são duas barreiras — a declaração, barata, e a contagem real
 * durante a leitura, que é a que vale.
 */

/** Inventário completo de uma estação com milhares de pacotes cabe folgado. */
export const LIMITE_INVENTARIO = 4 * 1024 * 1024

/** Inscrição é meia dúzia de campos curtos. */
export const LIMITE_INSCRICAO = 16 * 1024

/**
 * Um lote de métricas: até 500 amostras, cada uma com alguns volumes.
 *
 * 512 KB dá folga de uma ordem de grandeza sobre o lote máximo real (~50 KB), e
 * ainda assim é oito vezes menor que o teto do inventário. O limite por rota não
 * é burocracia: ele é o que impede uma rota barata de virar a porta por onde se
 * manda um corpo caro.
 */
export const LIMITE_METRICAS = 512 * 1024

type Resultado =
  | { ok: true; json: unknown }
  | { ok: false; resposta: NextResponse }

export async function lerCorpoLimitado(request: Request, limite: number): Promise<Resultado> {
  const declarado = Number(request.headers.get('content-length') ?? '0')
  if (declarado > limite) {
    return {
      ok: false,
      resposta: NextResponse.json({ erro: 'Corpo grande demais.' }, { status: 413 }),
    }
  }

  const corpo = request.body
  if (!corpo) {
    return {
      ok: false,
      resposta: NextResponse.json({ erro: 'Corpo ausente.' }, { status: 400 }),
    }
  }

  const leitor = corpo.getReader()
  const pedacos: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await leitor.read()
      if (done) break
      total += value.byteLength
      if (total > limite) {
        /* Cancela em vez de continuar lendo até o fim para recusar depois: quem
           mandou 400 MB não pode fazer o servidor receber 400 MB. */
        await leitor.cancel()
        return {
          ok: false,
          resposta: NextResponse.json({ erro: 'Corpo grande demais.' }, { status: 413 }),
        }
      }
      pedacos.push(value)
    }
  } catch {
    return {
      ok: false,
      resposta: NextResponse.json({ erro: 'Leitura interrompida.' }, { status: 400 }),
    }
  }

  const bytes = new Uint8Array(total)
  let posicao = 0
  for (const p of pedacos) {
    bytes.set(p, posicao)
    posicao += p.byteLength
  }

  try {
    return { ok: true, json: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return {
      ok: false,
      resposta: NextResponse.json({ erro: 'JSON inválido.' }, { status: 400 }),
    }
  }
}

/** O token da máquina, de `Authorization: Bearer ag_...`. */
export function tokenDoAgente(request: Request): string | null {
  const cabecalho = request.headers.get('authorization') ?? ''
  if (!cabecalho.startsWith('Bearer ')) return null
  const token = cabecalho.slice(7).trim()
  return token.length >= 16 ? token : null
}
