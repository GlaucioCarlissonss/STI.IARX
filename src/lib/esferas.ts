/**
 * As esferas de negócio — e por que elas não são permissão.
 *
 * Permissão responde **"esta pessoa pode abrir esta tela?"**. A esfera responde
 * **"esta tela existe neste negócio?"**. Um gestor de TI com todas as permissões
 * do mundo não deveria ver "Tabelas de franquia"; um locador não deveria ver
 * "Agentes nas máquinas". Misturar as duas perguntas é como um menu vira
 * depósito — e foi a razão de a esfera virar atributo da EMPRESA (migração
 * 0047), e não do usuário.
 *
 * ## O foco não é uma terceira esfera
 *
 * Quem tem as duas ganha um seletor no cabeçalho. Ele encurta o menu quando a
 * pessoa está num trabalho só, e **não dá nem tira acesso**: escolher "Locação"
 * esconde o atalho para Projetos, não o projeto — a busca (⌘K) continua achando
 * tudo, e o endereço digitado continua abrindo. Por isso ele mora num cookie, e
 * não na URL: é preferência de quem usa, como a densidade da lista, e não
 * estado de tela que se manda para outra pessoa por link.
 */

export const ESFERAS = ['management', 'rental'] as const
export type Esfera = (typeof ESFERAS)[number]

export const ROTULO_DA_ESFERA: Record<Esfera, string> = {
  management: 'Gestão de TI',
  rental: 'Locação e serviços',
}

export const RESUMO_DA_ESFERA: Record<Esfera, string> = {
  management:
    'A TI que responde pelo parque de um cliente. O dinheiro sai: nota de terceiro → título a pagar → orçamento.',
  rental:
    'O fornecedor que aluga equipamento próprio e presta serviço. O dinheiro entra: contrato + medição → fatura → título a receber.',
}

/** O que cada esfera acrescenta ao menu, em palavras de quem usa. */
export const TELAS_DA_ESFERA: Record<Esfera, string> = {
  management:
    'Inventário e monitoramento · Agentes · Telefonia · Links de internet · Projetos · Orçamento de TI · Visão de resultado',
  rental:
    'Frota · Contratos de locação · Medições e consumo · Faturamento · Manutenção em campo · Peças e estoque',
}

/**
 * Lê o que veio do banco (ou de um formulário) como lista de esferas.
 *
 * Desconhecido é descartado em vez de derrubar a página: a coluna tem CHECK, mas
 * esta função também roda sobre `FormData`, onde o valor é o que o navegador
 * mandou. Lista vazia vira `['management']` — a mesma regra do padrão da coluna,
 * porque uma sessão sem esfera nenhuma não veria tela nenhuma.
 */
export function lerEsferas(bruto: readonly unknown[] | null | undefined): Esfera[] {
  const limpas = (bruto ?? []).filter((v): v is Esfera =>
    ESFERAS.includes(v as Esfera),
  )
  const unicas = [...new Set(limpas)]
  return unicas.length > 0 ? unicas : ['management']
}

/** Nome do cookie do seletor de foco. */
export const COOKIE_DO_FOCO = 'esfera'

/**
 * O foco escolhido, validado contra as esferas que a empresa realmente tem.
 *
 * Um cookie antigo pode apontar para uma esfera que foi desligada depois — e
 * nesse caso o menu ficaria vazio, sem explicação. Aqui ele simplesmente deixa
 * de valer.
 */
export function lerFoco(
  cookie: string | undefined,
  esferasDaEmpresa: readonly Esfera[],
): Esfera | null {
  if (!cookie) return null
  const alvo = ESFERAS.find((e) => e === cookie)
  if (!alvo) return null
  if (!esferasDaEmpresa.includes(alvo)) return null
  // Focar a única esfera que existe não encurta nada e esconderia o seletor
  // mostrando um estado "filtrado" que é igual ao normal.
  if (esferasDaEmpresa.length < 2) return null
  return alvo
}

/**
 * As esferas que valem para montar o menu agora.
 *
 * Sem foco, valem todas as da empresa. Com foco, vale uma — e é só isso que o
 * foco faz.
 */
export function esferasEmUso(
  esferasDaEmpresa: readonly Esfera[],
  foco: Esfera | null,
): Esfera[] {
  return foco ? [foco] : [...esferasDaEmpresa]
}
