'use client'

import { useEffect } from 'react'

/**
 * Registra o service worker — e só isso.
 *
 * ## Por que um efeito, aqui, é o certo
 *
 * `navigator.serviceWorker` não existe no servidor, e o registro é um efeito
 * colateral de verdade: nada na tela depende do resultado. É o caso em que um
 * `useEffect` é a ferramenta, e não o contorno.
 *
 * ## Por que depois do `load`
 *
 * O registro disputa banda com o que a pessoa veio ver. Numa rede boa a
 * diferença é invisível; numa rede ruim — que é justamente quando um PWA
 * importa — ele atrasaria a primeira tela para instalar o que serve à segunda
 * visita.
 *
 * ## Por que o erro é engolido
 *
 * Service worker exige origem segura: `https` ou `localhost`. Numa prévia
 * servida por IP, o registro falha e não há nada a fazer a respeito — a
 * aplicação funciona igual, só não fica instalável. Gritar no console nesse caso
 * treinaria todo mundo a ignorar o console, que é o preço que esta base já
 * resolveu pagar uma vez com o favicon.
 */
export function RegistrarServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const registrar = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
    }

    if (document.readyState === 'complete') {
      registrar()
      return
    }
    window.addEventListener('load', registrar, { once: true })
    return () => window.removeEventListener('load', registrar)
  }, [])

  return null
}
