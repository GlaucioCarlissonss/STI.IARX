'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { COOKIE_DO_FOCO, ESFERAS } from '@/lib/esferas'

/**
 * Grava o foco do menu num cookie.
 *
 * ## Por que não precisa de permissão
 *
 * Porque não concede nada. O foco esconde atalhos do menu de quem escolheu
 * esconder; qualquer tela que ele tire do menu continua alcançável pela paleta
 * e pelo endereço, e continua governada pela permissão de sempre. Exigir uma
 * chave aqui daria a impressão de que isto é controle de acesso — e tratar
 * enfeite como segurança é como a segurança de verdade perde credibilidade.
 *
 * ## Por que `httpOnly`
 *
 * Nenhum JavaScript da página lê este valor: quem lê é o layout, no servidor.
 * Deixá-lo visível ao navegador só aumentaria a superfície sem servir a
 * ninguém.
 */
export async function focarEsfera(formData: FormData) {
  const bruto = String(formData.get('esfera') ?? '')
  const jar = await cookies()

  // Vazio = "as duas": apagar é mais honesto que gravar um valor que significa
  // "sem filtro", porque um cookie ausente e um cookie neutro teriam que ser
  // tratados do mesmo jeito em todo lugar que o lê.
  if (bruto === '') {
    jar.delete(COOKIE_DO_FOCO)
  } else {
    const alvo = ESFERAS.find((e) => e === bruto)
    // Valor estranho não vira erro na cara de quem clicou: vira nada. O botão
    // que manda outra coisa não existe na tela, então chegar aqui já é sinal de
    // requisição forjada — e a reação certa é ignorar.
    if (!alvo) return
    jar.set(COOKIE_DO_FOCO, alvo, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 180,
    })
  }

  /*
   * Revalida o layout, onde o menu mora — e quem recarrega a tela é o cliente,
   * com uma navegação de verdade.
   *
   * Três mecanismos foram medidos antes deste, e os três erravam em silêncio
   * numa execução de cada duas: a revalidação que viaja junto da resposta da
   * ação, um `router.refresh()` depois dela, e um `redirect()` para a mesma
   * tela — este último entregava o menu ANTERIOR, atrasado em um clique.
   *
   * Num controle cujo efeito inteiro é visual, "respondeu e nada mudou" é o
   * único resultado inaceitável: a pessoa conclui que o controle está quebrado
   * e desiste dele. Ver `components/seletor-de-esfera.tsx`.
   */
  revalidatePath('/', 'layout')

}
