import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // O painel de TV fica aberto por semanas; qualquer log de erro precisa ser
  // rastreável até a origem, então mantemos os source maps em produção.
  productionBrowserSourceMaps: true,
  // Rotas tipadas: um link para uma rota inexistente vira erro de compilação,
  // não 404 em produção.
  typedRoutes: true,
}

export default nextConfig
