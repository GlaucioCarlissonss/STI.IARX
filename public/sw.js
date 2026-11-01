/*
 * Service worker do STI — o mínimo que sobrevive a uma rede ruim.
 *
 * O QUE ELE FAZ, E PRINCIPALMENTE O QUE ELE NÃO FAZ
 * -------------------------------------------------
 * Ele NÃO guarda página autenticada. Nem uma. Esta é uma aplicação
 * multi-tenant, e página guardada é página que pode reaparecer para a próxima
 * pessoa que abrir o navegador daquele computador — num balcão, num
 * compartilhado de recepção. Nenhuma economia de rede vale isso.
 *
 * O que ele guarda é o que não tem dono: os arquivos estáticos que o Next
 * publica com hash no nome (`/_next/static/...`), os ícones e a página de
 * "sem conexão". Arquivo com hash no nome nunca muda de conteúdo, então
 * guardá-lo para sempre é seguro por construção.
 *
 * O que ele faz com navegação é só isto: tenta a rede e, se a rede falhar,
 * mostra a página de sem conexão em vez do dinossauro do navegador. A diferença
 * entre as duas é que a nossa diz o que aconteceu e o que fazer.
 *
 * POR QUE `network-first` E NÃO `cache-first`
 * --------------------------------------------
 * Porque um cache-first num sistema de chamados mostra o chamado de ontem como
 * se fosse o de agora. Ficar sem resposta é ruim; receber resposta errada com
 * cara de certa é pior, e é o defeito que ninguém reporta porque ninguém
 * percebe.
 *
 * SOBRE TROCAR DE VERSÃO
 * ----------------------
 * `VERSAO` no nome do cache: subir o número descarta tudo o que havia. Sem isso,
 * um arquivo guardado por engano ficaria para sempre, e o único remédio seria
 * pedir para a pessoa limpar o navegador.
 */
const VERSAO = 'sti-v1'
const CACHE = `${VERSAO}-estatico`
const SEM_CONEXAO = '/sem-conexao'

/* O esqueleto mínimo: a página de erro de rede e os ícones. Nada mais entra
   aqui na instalação — o resto é guardado conforme for usado. */
const ESSENCIAIS = [SEM_CONEXAO, '/icones/icone-192.png']

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ESSENCIAIS))
      /* `skipWaiting` para a versão nova assumir sem esperar todas as abas
         fecharem. Num sistema de operação, "feche todas as abas" é um pedido
         que ninguém atende. */
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((nomes) =>
        Promise.all(nomes.filter((n) => !n.startsWith(VERSAO)).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  )
})

/** Arquivo com hash no nome: o conteúdo nunca muda, guardar é seguro. */
function ehEstaticoImutavel(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icones/') ||
    url.pathname === '/icon.svg'
  )
}

self.addEventListener('fetch', (evento) => {
  const req = evento.request

  /* Só GET. Um POST guardado e repetido criaria o mesmo chamado duas vezes. */
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  /* Nada de API passa por aqui: `/api/jobs`, `/api/canais` e
     `/api/monitoramento` são chamadas de máquina, e as de dado são sessão de
     alguém. O service worker não tem o que acrescentar a nenhuma das duas. */
  if (url.pathname.startsWith('/api/')) return

  if (ehEstaticoImutavel(url)) {
    evento.respondWith(
      caches.match(req).then(
        (guardado) =>
          guardado ??
          fetch(req).then((resposta) => {
            if (resposta.ok) {
              const copia = resposta.clone()
              caches.open(CACHE).then((c) => c.put(req, copia))
            }
            return resposta
          }),
      ),
    )
    return
  }

  /* Navegação: rede primeiro, página de sem conexão como último recurso. A
     resposta NÃO é guardada — ver o cabeçalho deste arquivo. */
  if (req.mode === 'navigate') {
    evento.respondWith(
      fetch(req).catch(() =>
        caches.match(SEM_CONEXAO).then(
          (pagina) =>
            pagina ??
            new Response('Sem conexão.', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            }),
        ),
      ),
    )
  }
})
