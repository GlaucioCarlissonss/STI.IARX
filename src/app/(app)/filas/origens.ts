/**
 * Origens aceitas na condição de roteamento.
 *
 * Lista fechada e curta de propósito: `tickets.source_system` é texto livre, mas
 * oferecer um campo aberto aqui criaria regra que depende de alguém digitar
 * exatamente o mesmo valor que a integração grava — e um acento de diferença
 * faria a regra nunca casar, em silêncio.
 *
 * Mora em arquivo próprio porque a lista é usada tanto pela tela (para descrever
 * a condição em português) quanto pela gaveta (para montar o seletor).
 */
export const ORIGENS = ['bitrix24', 'api', 'email'] as const
