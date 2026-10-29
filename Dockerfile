# =============================================================================
# A aplicação, para `docker compose up`.
#
# É uma imagem de DESENVOLVIMENTO, e vale dizer o que isso significa aqui: ela
# existe para alguém ver o produto rodando sem instalar Node nem PostgreSQL na
# própria máquina. Não é a imagem de produção — em produção o app roda sobre o
# Supabase (ver docs/22, seção 7), e nem o banco nem as senhas deste compose
# existem lá.
#
# POR QUE UM ESTÁGIO SÓ
# ---------------------
# Multi-stage encolheria a imagem, e encolher não é o que importa num ambiente
# em que a pessoa vai querer abrir um terminal dentro do contêiner para rodar a
# suíte ou olhar um erro. Um estágio só mantém `npm test`, `npx tsc` e os
# arquivos de origem todos à mão.
# =============================================================================
FROM node:22-slim

WORKDIR /app

# As dependências primeiro, e separadas do resto: enquanto o `package-lock.json`
# não mudar, o Docker reaproveita esta camada e não reinstala nada a cada
# alteração de código.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# As `NEXT_PUBLIC_*` são lidas em tempo de BUILD — o Next as escreve dentro do
# pacote que vai para o navegador. Defini-las só no compose não teria efeito
# nenhum sobre o que o navegador recebe, e é por isso que elas estão aqui.
#
# O valor é `placeholder` de propósito: é ele que liga o modo local
# (`src/lib/db/modo.ts`). Com uma URL de Supabase de verdade aqui, o modo local
# NÃO liga — e isso é a proteção, não um descuido.
ENV NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder

RUN npm run build

EXPOSE 3177

# `-H 0.0.0.0` porque o padrão do Next escuta só em localhost, e localhost
# dentro do contêiner não é o localhost de quem abriu o navegador: sem isto a
# porta publicada responde "connection reset" e parece que o app não subiu.
CMD ["npx", "next", "start", "-p", "3177", "-H", "0.0.0.0"]
