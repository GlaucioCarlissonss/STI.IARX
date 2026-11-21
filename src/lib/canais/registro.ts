import { bitrix24 } from './bitrix24'
import { email } from './email'
import { n8n } from './n8n'
import { whatsapp } from './whatsapp'
import type { Provedor } from './tipos'

/**
 * De `kind` para adaptador.
 *
 * O mapa é exaustivo por tipo (`Record<Kind, Provedor>`), então acrescentar um
 * tipo em `channels.kind` sem escrever o adaptador **não compila**. É a trava que
 * impede um canal de ser criado no banco e descoberto em produção como "não faz
 * nada": o tipo novo no CHECK da migração e o adaptador novo aqui andam juntos ou
 * o build quebra.
 */
import type { TipoDeCanal } from './rotulos'

export type { TipoDeCanal }

const PROVEDORES: Record<TipoDeCanal, Provedor> = {
  whatsapp,
  email,
  bitrix24,
  n8n,
}

export function provedorDoCanal(kind: string): Provedor | null {
  return PROVEDORES[kind as TipoDeCanal] ?? null
}

