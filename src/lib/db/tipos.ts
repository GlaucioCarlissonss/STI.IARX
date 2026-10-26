import { types } from 'pg'

/**
 * Faz o `pg` devolver o que o PostgREST devolveria.
 *
 * ## O defeito que isto corrige, e como ele apareceu
 *
 * Na primeira varredura das telas em modo local, três quebraram com erros que
 * não tinham nada a ver umas com as outras:
 *
 *     TypeError: a.slice is not a function
 *     TypeError: a.split is not a function
 *     TypeError: d.rating.toFixed is not a function
 *
 * A causa é uma só. O PostgREST entrega **JSON**: `numeric` vira número,
 * `timestamptz` vira texto ISO. O driver `pg` entrega **tipos de JavaScript**:
 * `numeric` vira string (para não perder precisão) e `timestamptz` vira `Date`.
 *
 * Então `competencia.slice(0, 7)` quebra num `Date`, e `rating.toFixed(1)`
 * quebra numa string. O app está certo nos dois casos — ele foi escrito contra
 * o contrato do PostgREST, e é esse contrato que o modo local tem de cumprir.
 *
 * ## Por que converter aqui, e não nas telas
 *
 * Porque a alternativa é espalhar `Number(...)` e `String(...)` por 333 consultas
 * para acomodar um driver — e aí o modo local deixaria de ser um detalhe de
 * transporte e passaria a moldar o código da aplicação. Pior: o app ficaria
 * tolerante a dois formatos, e a diferença entre eles sumiria de vista.
 *
 * ## O que se perde em `numeric`
 *
 * Precisão acima de 2^53, que é o que o JSON também perde — o PostgREST tem
 * exatamente a mesma limitação, pelo mesmo motivo. Em `numeric(14,2)`, que é o
 * tipo do dinheiro nesta base, o maior valor é 999.999.999.999,99: cabe com
 * folga.
 */

const INT8 = 20
const NUMERIC = 1700
const TIMESTAMP = 1114
const TIMESTAMPTZ = 1184
const DATE = 1082
const INT8_ARRAY = 1016
const NUMERIC_ARRAY = 1231
const TIMESTAMPTZ_ARRAY = 1185

/*
 * `@types/pg` tipa o OID como um enum fechado que não inclui os OIDs de ARRAY
 * (1016, 1231, 1185). Eles existem e funcionam; o que falta é a declaração.
 * Uma assinatura local é mais honesta que um `as never` em cada chamada.
 */
const definirParser = types.setTypeParser as unknown as (
  oid: number,
  fn: (valor: string) => unknown,
) => void
const obterParser = types.getTypeParser as unknown as (
  oid: number,
) => (valor: string) => unknown

let configurado = false

export function configurarTipos(): void {
  if (configurado) return
  configurado = true

  const paraNumero = (v: string | null) => (v === null ? null : Number(v))
  definirParser(INT8, paraNumero as (v: string) => number)
  definirParser(NUMERIC, paraNumero as (v: string) => number)

  /*
   * Data sem hora fica como veio: "2026-10-01". Deixar o `pg` transformá-la em
   * `Date` criaria meia-noite no fuso do servidor — e uma competência de
   * outubro viraria 30 de setembro em qualquer fuso a oeste de Greenwich. É um
   * erro de um mês inteiro, e ele só aparece para metade do planeta.
   */
  definirParser(DATE, (v: string) => v)

  const paraIso = (v: string) => {
    /* O Postgres entrega "2026-10-25 18:00:00+00". `Date` entende, e o ISO de
       volta é o que o PostgREST teria mandado. */
    const d = new Date(v.includes('T') ? v : v.replace(' ', 'T'))
    return Number.isNaN(d.getTime()) ? v : d.toISOString()
  }
  definirParser(TIMESTAMPTZ, paraIso)
  definirParser(TIMESTAMP, (v: string) => paraIso(v.endsWith('Z') ? v : `${v}Z`))

  /* Arrays dos mesmos tipos. O analisador de array do `pg` chama o parser do
     elemento, então basta registrar o do elemento — menos estes três, que têm
     parser próprio de array. */
  const arrayDeNumeros = obterParser(INT8_ARRAY)
  definirParser(INT8_ARRAY, (v: string) =>
    (arrayDeNumeros(v) as (string | null)[]).map(paraNumero),
  )
  const arrayDeNumeric = obterParser(NUMERIC_ARRAY)
  definirParser(NUMERIC_ARRAY, (v: string) =>
    (arrayDeNumeric(v) as (string | null)[]).map(paraNumero),
  )
  const arrayDeDatas = obterParser(TIMESTAMPTZ_ARRAY)
  definirParser(TIMESTAMPTZ_ARRAY, (v: string) =>
    (arrayDeDatas(v) as (string | null)[]).map((x) => (x === null ? null : paraIso(String(x)))),
  )
}
