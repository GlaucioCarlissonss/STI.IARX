import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
   * A saída autocontida, LIGADA POR VARIÁVEL e não sempre.
   *
   * `standalone` faz o Next copiar para `.next/standalone` só o que o servidor
   * precisa em tempo de execução — e é o que permite a imagem de produção
   * descartar `node_modules` inteiro (centenas de MB de ferramenta de build que
   * em produção são superfície de ataque, não função).
   *
   * Por que não deixar sempre ligado: a imagem de desenvolvimento e o
   * `npm run dev` de quem está trabalhando não usam essa saída, e gerá-la em
   * todo build custa tempo e confunde quem for procurar onde o build foi parar.
   * `BUILD_STANDALONE=1` é setado pelo `Dockerfile.producao`, e só por ele.
   */
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,
  /*
   * O que a saída autocontida NÃO deve levar junto.
   *
   * Sem esta lista, `standalone` copia a árvore inteira do projeto: medi, e
   * foram 393 arquivos de `src/`, mais `docs/`, `demo/`, `supabase/` com todas
   * as migrações e o código do agente — tudo dentro da imagem que vai para a
   * internet. O servidor compilado vive em `.next/server`; o TypeScript de
   * origem ali não roda nada, só informa quem conseguir ler o disco do contêiner.
   *
   * `supabase/` merece menção: são as migrações, e elas descrevem o modelo de
   * dados inteiro, incluindo cada policy de RLS. É exatamente o mapa que alguém
   * procurando brecha gostaria de ter.
   *
   * A verificação de que nada aqui era necessário foi rodar o `server.js`
   * resultante e abrir a aplicação — e não ler o código e concluir que dava.
   */
  outputFileTracingExcludes: {
    '*': [
      'docs/**',
      'demo/**',
      'entrega/**',
      'agente/**',
      'supabase/**',
      'scripts/**',
      'src/**',
      '.next/cache/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/tsconfig.tsbuildinfo',
    ],
  },
  // O painel de TV fica aberto por semanas; qualquer log de erro precisa ser
  // rastreável até a origem, então mantemos os source maps em produção.
  productionBrowserSourceMaps: true,
  // Rotas tipadas: um link para uma rota inexistente vira erro de compilação,
  // não 404 em produção.
  typedRoutes: true,
}

export default nextConfig
