import { NextResponse } from 'next/server'

/**
 * O que o agente pergunta antes de se atualizar.
 *
 * ## Por que a autoatualização é fechada por padrão
 *
 * Duzentas máquinas não se atualizam à mão — e um agente que se atualiza errado é
 * um incidente em duzentos lugares ao mesmo tempo, dentro da rede do cliente, com
 * privilégio de serviço. Os dois lados desse risco são grandes, e o segundo é
 * maior.
 *
 * Por isso esta rota responde **204 (nada a fazer)** quando as variáveis de
 * publicação não existem. Não é um erro e não é um defeito: é um agente que
 * continua rodando a versão que foi instalada, que é o estado seguro. O estado
 * inseguro seria o contrário — um endpoint que, por falta de configuração,
 * respondesse "baixe este arquivo" apontando para lugar nenhum.
 *
 * ## O que o agente verifica, e por que o servidor não basta
 *
 * A resposta traz o SHA-256 **e** uma assinatura Ed25519 do binário. O agente
 * carrega a chave pública compilada dentro dele e confere a assinatura antes de
 * trocar o executável; sem chave pública compilada, ele **recusa** atualizar.
 *
 * Isso é deliberadamente paranoico com o próprio servidor. Se só o hash fosse
 * conferido, quem controlasse esta rota controlaria o binário que roda como
 * serviço em todas as máquinas do cliente — e "esta rota" inclui quem tiver
 * acesso de escrita às variáveis de ambiente, quem fizer um ataque de DNS, e
 * qualquer intermediário que termine o TLS. A assinatura move a confiança do
 * servidor para a chave privada, que fica fora dele.
 *
 * `AGENT_RELEASE_SIGNATURE` faltando, com as outras presentes, é publicação pela
 * metade: a rota responde 204 em vez de servir um binário que o agente vai acabar
 * recusando de qualquer jeito. Melhor não anunciar do que anunciar e falhar em
 * duzentos lugares.
 */

export const dynamic = 'force-dynamic'

export async function GET() {
  const versao = process.env.AGENT_RELEASE_VERSION
  const url = process.env.AGENT_RELEASE_URL
  const sha256 = process.env.AGENT_RELEASE_SHA256
  const assinatura = process.env.AGENT_RELEASE_SIGNATURE

  if (!versao || !url || !sha256 || !assinatura) {
    return new NextResponse(null, { status: 204 })
  }

  return NextResponse.json({
    versao,
    url,
    sha256,
    assinatura,
    /* Em minutos. O agente respeita este número em vez de ter o intervalo fixo no
       código: numa emergência (uma versão com defeito publicada por engano), subir
       o intervalo pelo servidor é mais rápido que recompilar e redistribuir. */
    checar_a_cada_min: Number(process.env.AGENT_UPDATE_CHECK_MIN ?? '720'),
  })
}
