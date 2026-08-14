/**
 * Endereço estruturado brasileiro e o relatório técnico de geolocalização.
 *
 * Módulo sem dependências e sem I/O: tudo aqui é função pura, testável, e é
 * compartilhado pelo app, pelas Server Actions e pelo protótipo em `demo/`.
 * A chamada de rede vive em `geocode.server.ts` — separar as duas coisas é o
 * que permite testar cada exceção do fluxo sem depender do provedor estar de pé.
 */

import { type GeocodePrecision, PRECISION_LABEL, formatCoordinates } from './maps'

/* ==========================================================================
   Endereço
   ========================================================================== */

/**
 * Os quatro campos obrigatórios (logradouro, número, bairro, CEP) mais os
 * opcionais. Cidade e UF não são exigidos porque o CEP os determina — e, quando
 * vêm preenchidos, servem justamente para a checagem de consistência.
 */
export interface StructuredAddress {
  street: string | null
  streetNumber: string | null
  district: string | null
  postalCode: string | null
  city?: string | null
  state?: string | null
  complement?: string | null
}

export const REQUIRED_ADDRESS_FIELDS = [
  { key: 'street', label: 'logradouro' },
  { key: 'streetNumber', label: 'número' },
  { key: 'district', label: 'bairro' },
  { key: 'postalCode', label: 'CEP' },
] as const

export type RequiredAddressField = (typeof REQUIRED_ADDRESS_FIELDS)[number]['key']

const blank = (v: string | null | undefined) => (v ?? '').trim() === ''

/** Rótulos dos campos obrigatórios que estão em branco no cadastro. */
export function missingRequiredFields(address: StructuredAddress): string[] {
  return REQUIRED_ADDRESS_FIELDS.filter(({ key }) => blank(address[key])).map((f) => f.label)
}

/* --- CEP --------------------------------------------------------------- */

const CEP_DIGITS = 8

/** `01310-200` ou `01310200` → `01310-200`. Devolve null se não der 8 dígitos. */
export function normalizeCep(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '')
  if (digits.length !== CEP_DIGITS) return null
  return `${digits.slice(0, 5)}-${digits.slice(5)}`
}

export function isValidCep(value: string | null | undefined): boolean {
  return normalizeCep(value) !== null
}

/* --- Formatação -------------------------------------------------------- */

/** Endereço em uma linha, no padrão dos Correios. */
export function formatAddress(address: StructuredAddress): string {
  const street = [address.street, address.streetNumber].map((p) => (p ?? '').trim()).filter(Boolean)
  const head = street.join(', ')
  const withComplement = [head, (address.complement ?? '').trim()].filter(Boolean).join(' - ')
  const cityState = [(address.city ?? '').trim(), (address.state ?? '').trim().toUpperCase()]
    .filter(Boolean)
    .join('/')
  return [withComplement, (address.district ?? '').trim(), cityState, normalizeCep(address.postalCode)]
    .filter(Boolean)
    .join(', ')
}

/**
 * Consulta enviada ao geocodificador.
 *
 * Diferente de `formatAddress`, o complemento é deixado de fora: "sala 402" não
 * ajuda a Geocoding API a achar o edifício e, na prática, degrada o resultado —
 * o serviço passa a tratar a string como aproximada.
 */
export function geocodeQuery(address: StructuredAddress): string {
  return [
    [address.street, address.streetNumber].map((p) => (p ?? '').trim()).filter(Boolean).join(', '),
    (address.district ?? '').trim(),
    (address.city ?? '').trim(),
    (address.state ?? '').trim().toUpperCase(),
    normalizeCep(address.postalCode),
    'Brasil',
  ]
    .filter(Boolean)
    .join(', ')
}

/* ==========================================================================
   Consistência entre o CEP e o resto do endereço
   ========================================================================== */

/** O que a consulta de CEP devolve, no mínimo comum entre provedores. */
export interface CepLookup {
  postalCode: string
  street: string | null
  district: string | null
  city: string | null
  state: string | null
}

/**
 * Abreviações de tipo de logradouro, na forma JÁ normalizada — a comparação
 * roda depois de tirar acento e pontuação, então a chave aqui é "pc", não "pç.".
 */
const ABBREVIATIONS: [RegExp, string][] = [
  [/^r$/, 'rua'],
  [/^av$|^avda$/, 'avenida'],
  [/^al$/, 'alameda'],
  [/^pc$|^pca$|^pr$/, 'praca'],
  [/^rod$/, 'rodovia'],
  [/^trav$|^tv$/, 'travessa'],
  [/^est$/, 'estrada'],
  [/^lgo$/, 'largo'],
]

/**
 * Normaliza para comparar: sem acento, sem caixa, sem pontuação, com o tipo de
 * logradouro expandido. "Av. Paulista" e "AVENIDA PAULISTA" têm de bater —
 * senão a checagem de consistência acusaria divergência em todo cadastro
 * abreviado, e o operador aprenderia a ignorar o aviso.
 */
export function normalizeForCompare(value: string | null | undefined): string {
  const base = (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marcas de acento separadas pelo NFD
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return ''

  // Só a primeira palavra é expandida: é onde vive o tipo do logradouro.
  const [first, ...rest] = base.split(' ')
  const match = ABBREVIATIONS.find(([re]) => re.test(first))
  return [match ? match[1] : first, ...rest].join(' ')
}

export interface ConsistencyResult {
  consistent: boolean
  /** Divergências em linguagem de operador, para exibir e para o log. */
  issues: string[]
}

/**
 * Compara o endereço cadastrado com o que o CEP informa.
 *
 * Cidade e UF são tratadas como divergência dura: CEP de São Paulo com
 * logradouro de outra cidade é o caso clássico de troca de campo. Logradouro e
 * bairro são comparados por continência, porque a base dos Correios abrevia e
 * o cadastro raramente reproduz a grafia exata.
 */
export function checkAddressConsistency(
  address: StructuredAddress,
  lookup: CepLookup | null,
): ConsistencyResult {
  if (!lookup) return { consistent: true, issues: [] }
  const issues: string[] = []

  const cmp = (a: string | null | undefined, b: string | null | undefined) => {
    const x = normalizeForCompare(a)
    const y = normalizeForCompare(b)
    if (!x || !y) return true
    return x === y || x.includes(y) || y.includes(x)
  }

  if (address.state && lookup.state && normalizeForCompare(address.state) !== normalizeForCompare(lookup.state))
    issues.push(`UF cadastrada "${address.state}" divergente da UF do CEP "${lookup.state}"`)

  if (address.city && lookup.city && !cmp(address.city, lookup.city))
    issues.push(`Cidade cadastrada "${address.city}" divergente da cidade do CEP "${lookup.city}"`)

  if (address.street && lookup.street && !cmp(address.street, lookup.street))
    issues.push(`Logradouro cadastrado "${address.street}" divergente do logradouro do CEP "${lookup.street}"`)

  if (address.district && lookup.district && !cmp(address.district, lookup.district))
    issues.push(`Bairro cadastrado "${address.district}" divergente do bairro do CEP "${lookup.district}"`)

  return { consistent: issues.length === 0, issues }
}

/* ==========================================================================
   Resultado do fluxo
   ========================================================================== */

/** Um candidato devolvido pelo geocodificador. */
export interface GeocodeCandidate {
  lat: number
  lng: number
  formattedAddress: string
  precision: GeocodePrecision
  placeId: string | null
  /** Verdadeiro quando o provedor marcou o resultado como parcial. */
  partial?: boolean
}

/**
 * Códigos de exceção do fluxo. São os mesmos que aparecem na UI e no log — um
 * código só, em um lugar só, evita que a tela diga uma coisa e o log outra.
 */
export type GeocodeStatus =
  | 'ok'
  | 'low_precision'
  | 'missing_fields'
  | 'inconsistent'
  | 'multiple'
  | 'not_found'
  | 'service_unavailable'

export const STATUS_TAG: Record<GeocodeStatus, string> = {
  ok: '[OK]',
  low_precision: '[BAIXA PRECISÃO]',
  missing_fields: '[CAMPO AUSENTE]',
  inconsistent: '[INCONSISTÊNCIA DE ENDEREÇO]',
  multiple: '[MÚLTIPLAS CORRESPONDÊNCIAS]',
  not_found: '[ENDEREÇO NÃO ENCONTRADO]',
  service_unavailable: '[SERVIÇO INDISPONÍVEL]',
}

/** Só estes dois estados autorizam desenhar o mapa. */
export function shouldRender(status: GeocodeStatus): boolean {
  return status === 'ok' || status === 'low_precision'
}

/**
 * Zoom por precisão, dentro da faixa 16–18 exigida para identificar o imóvel.
 * Precisão de rua não merece 18: aproximar mais do que o dado permite passa uma
 * confiança que o dado não tem.
 */
export function zoomForPrecision(precision: GeocodePrecision): number {
  switch (precision) {
    case 'rooftop':
    case 'manual':
      return 18
    case 'range_interpolated':
      return 17
    default:
      return 16
  }
}

/** Requisitos mínimos, listados quando alguma dependência não está disponível. */
export const SERVICE_REQUIREMENTS = [
  'API de geocodificação com cobertura brasileira e nível de precisão no retorno (variável GOOGLE_MAPS_SERVER_KEY)',
  'API de tiles com camada de satélite em zoom 16–18 (variável NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, restrita por referrer)',
  'Biblioteca de renderização com camadas, marcador, popup e alternância satélite/mapa (Maps JavaScript API)',
  'Consulta de CEP para validar consistência (variável CEP_LOOKUP_URL, padrão ViaCEP)',
  'Mecanismo de tempo real para reexecutar o fluxo quando o cadastro muda (Supabase Realtime em public.branches)',
]

export interface GeocodeReport {
  status: GeocodeStatus
  input: StructuredAddress
  missing: string[]
  consistency: ConsistencyResult
  cepLookup: CepLookup | null
  candidates: GeocodeCandidate[]
  chosen: GeocodeCandidate | null
  provider: string | null
  /** Mensagem de operador: o que fazer a seguir. */
  message: string
  requirements: string[]
  timestamp: string
}

/* ==========================================================================
   Relatório técnico
   ========================================================================== */

const yesNo = (v: boolean) => (v ? 'sim' : 'não')

/**
 * Bloco de saída técnica no formato acordado.
 *
 * É gerado a partir do MESMO objeto que alimenta a interface e a tabela de log,
 * então o que o operador lê na tela e o que fica registrado não podem divergir.
 */
export function buildReportText(report: GeocodeReport): string {
  const a = report.input
  const value = (v: string | null | undefined) => ((v ?? '').trim() || '[AUSENTE]')

  const validation = report.missing.length
    ? `INCOMPLETO — ausentes: ${report.missing.join(', ')}`
    : 'COMPLETO'
  const consistency = report.cepLookup
    ? report.consistency.consistent
      ? 'CONSISTENTE'
      : `INCONSISTENTE — ${report.consistency.issues.join('; ')}`
    : 'NÃO VERIFICADA — consulta de CEP indisponível'

  const geo = report.chosen
    ? [
        `- Coordenadas: ${formatCoordinates(report.chosen.lat, report.chosen.lng)}`,
        `- Endereço formatado: ${report.chosen.formattedAddress}`,
        `- Nível de precisão: ${report.chosen.precision} (${PRECISION_LABEL[report.chosen.precision]})`,
      ]
    : [
        `- Coordenadas: ${STATUS_TAG[report.status]} — não obtidas`,
        '- Endereço formatado: —',
        '- Nível de precisão: —',
      ]

  const multiples =
    report.candidates.length > 1
      ? [
          `- Correspondências múltiplas: sim (${report.candidates.length}) — aguardando confirmação do operador`,
          ...report.candidates.map(
            (c, i) =>
              `  ${i + 1}. ${c.formattedAddress} — ${formatCoordinates(c.lat, c.lng)} (${c.precision})`,
          ),
        ]
      : ['- Correspondências múltiplas: não']

  const render = shouldRender(report.status)
  const zoom = report.chosen ? zoomForPrecision(report.chosen.precision) : null

  return [
    'ENDERECO DE ENTRADA:',
    `- Logradouro: ${value(a.street)}`,
    `- Número: ${value(a.streetNumber)}`,
    `- Bairro: ${value(a.district)}`,
    `- CEP: ${normalizeCep(a.postalCode) ?? value(a.postalCode)}`,
    `- Complemento: ${(a.complement ?? '').trim() || 'não informado'}`,
    '',
    'VALIDACAO:',
    `- Campos obrigatórios: ${validation}`,
    `- Consistência CEP/Logradouro: ${consistency}`,
    '',
    'GEOCODIFICACAO:',
    ...geo,
    ...multiples,
    '',
    'RENDERIZACAO:',
    `- Mapa: ${render ? 'renderizado em modo satélite' : 'NÃO renderizado'}`,
    `- Zoom: ${zoom ?? '—'}`,
    `- Marcador: ${report.chosen ? `posicionado em ${formatCoordinates(report.chosen.lat, report.chosen.lng)}` : '—'}`,
    `- Popup: ${report.chosen ? `${report.chosen.formattedAddress} + ${PRECISION_LABEL[report.chosen.precision]}` : '—'}`,
    `- Alternância satélite/mapa: ${yesNo(render)}`,
    '',
    'LOG:',
    `- Timestamp: ${report.timestamp}`,
    `- Serviço utilizado: ${report.provider ?? 'não disponível'}`,
    `- Status: ${report.status === 'ok' ? 'SUCESSO' : `${STATUS_TAG[report.status]} — ${report.message}`}`,
    ...(report.status === 'service_unavailable'
      ? ['', 'REQUISITOS MINIMOS:', ...report.requirements.map((r) => `- ${r}`)]
      : []),
  ].join('\n')
}
