import { timingSafeEqual, createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { provedorConfigurado } from '@/lib/mail/provedor'
import { drenarCaixaDeSaida, type ClienteDaCaixa } from '@/lib/mail/caixa-de-saida'
import { drenarSaidaDosCanais, type ClienteDaSaida } from '@/lib/canais/saida'

/**
 * O disparador dos trabalhos agendados.
 *
 * ## Por que um endpoint, e não `pg_cron`
 *
 * O Supabase desta instalação é auto-hospedado sob Coolify, e não dá para
 * afirmar daqui que `pg_cron` está instalado. Um endpoint protegido é chamado
 * por qualquer agendador — cron do Coolify, GitHub Actions, `pg_net` se houver
 * `pg_cron`, ou um `curl` no crontab de uma máquina qualquer. Portável, e
 * testável sem agendador nenhum.
 *
 * ## O terceiro uso de `service_role`, declarado
 *
 * O ADR-011 limita a chave de serviço a dois usos. Este é o terceiro, e está
 * escrito também no cabeçalho da migração 0029 em vez de aberto em silêncio:
 * **um trabalho agendado não tem sessão de usuário por definição.** Não existe
 * `auth.uid()` às três da manhã.
 *
 * O que contém o estrago: as três funções que esta rota chama são
 * `security definer`, não aceitam parâmetro de tenant, devolvem apenas uma
 * contagem, e a única porta que as alcança é esta — protegida por um segredo
 * **próprio**, separado de qualquer outra credencial.
 *
 * ## Por que POST e não GET
 *
 * Isto altera dados: fecha chamado, enfileira e-mail. Um GET seria pré-buscado
 * por um navegador, por um antivírus de rede ou por quem passasse o link num
 * aplicativo de mensagem — e os três fechariam chamado sem ninguém pedir.
 */

export const dynamic = 'force-dynamic'

/**
 * Comparação em tempo constante, e com digest em vez do valor cru.
 *
 * `timingSafeEqual` exige buffers do mesmo tamanho, e o tamanho do segredo
 * recebido é informação: comparar direto vazaria o comprimento pelo erro. O
 * SHA-256 dos dois lados dá 32 bytes sempre, e a comparação só diferencia pelo
 * conteúdo.
 */
function segredoConfere(recebido: string, esperado: string): boolean {
  const a = createHash('sha256').update(recebido).digest()
  const b = createHash('sha256').update(esperado).digest()
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const esperado = process.env.JOBS_SECRET
  if (!esperado) {
    /*
     * Sem segredo configurado a rota fica FECHADA, e não aberta. Um endpoint que
     * fecha chamado e dispara e-mail não pode cair em "modo sem senha" por
     * esquecimento de variável — que é exatamente quando isso aconteceria.
     */
    return NextResponse.json({ erro: 'Trabalhos agendados não configurados.' }, { status: 503 })
  }

  const cabecalho = request.headers.get('authorization') ?? ''
  const recebido = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : ''
  if (!recebido || !segredoConfere(recebido, esperado)) {
    return NextResponse.json({ erro: 'Não autorizado.' }, { status: 401 })
  }

  const supabase = createAdminClient()

  /*
   * Em série, e de propósito: `satisfaction_invites` depende de chamados que o
   * `auto_close` acabou de fechar. Em paralelo, o convite do que fechou agora só
   * sairia na execução seguinte — o que funciona, mas atrasa a pesquisa em um
   * ciclo inteiro sem motivo.
   */
  /*
   * A ORDEM É A DEPENDÊNCIA, e os três trabalhos do agente (0032) entram no fim
   * por uma razão específica:
   *
   * · `aggregate_metrics` antes de `agent_alerts` não é obrigatório hoje — o
   *   alerta de disco lê `agent_volume_samples`, que já entra agregada. Mas
   *   agregar primeiro é o que mantém a ordem verdadeira quando um alerta passar
   *   a olhar a série por hora, e inverter depois é o tipo de mudança que ninguém
   *   lembra de fazer.
   *
   * · `purge_metrics` por ÚLTIMO, sempre. Ele apaga o detalhe; rodá-lo antes da
   *   agregação jogaria fora amostras que ainda não viraram agregado, e o buraco
   *   no gráfico apareceria semanas depois, sem causa visível.
   */
  const resultados: Record<string, number | string> = {}
  for (const job of [
    'job_auto_close',
    'job_sla_alerts',
    'job_satisfaction_invites',
    'job_aggregate_metrics',
    'job_agent_alerts',
    'job_purge_metrics',
  ] as const) {
    const { data, error } = await supabase.schema('app').rpc(job)
    if (error) {
      console.error('[jobs]', job, error.message)
      resultados[job] = 'falhou'
      continue
    }
    resultados[job] = Number(data ?? 0)
  }

  const origem = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
  const envio = await drenarCaixaDeSaida(
    supabase as unknown as ClienteDaCaixa,
    provedorConfigurado(),
    origem,
  )

  /*
   * A saída dos canais drena por ÚLTIMO, e é dependência, não preferência: os
   * trabalhos acima criam chamado e comentário (o fechamento automático, o
   * convite de avaliação), e comentário público num chamado com conversa aberta
   * vira mensagem na fila pela trigger da 0034. Drenar antes deles deixaria essa
   * resposta esperando o ciclo seguinte.
   */
  const canais = await drenarSaidaDosCanais(supabase as unknown as ClienteDaSaida)

  return NextResponse.json({
    executado_em: new Date().toISOString(),
    ...resultados,
    email: envio,
    canais,
  })
}
