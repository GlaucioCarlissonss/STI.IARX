# Ferramenta navegável (protótipo de interface)

`sti-tool.html` é uma página autocontida que implementa a **interface** das 11 melhorias
especificadas em [../docs/06-lacunas-e-roadmap.md](../docs/06-lacunas-e-roadmap.md).

Serve para avaliar e demonstrar o comportamento das telas antes de portá-las para o app
Next.js. Abra o arquivo direto no navegador — não precisa de servidor.

## O que ela é

Operacional de verdade: abrir ticket, mover status pela máquina de estados, transferir em
massa com motivo, editar SLA com preview de impacto, gerenciar áreas por filial, anexar
documentos e fotos, registrar custódia, cadastrar linhas e links, editar mapeamento de
integração com dry run, e navegar os mapas por filial. Tudo persiste em `localStorage`.

## O que ela não é

- **Monousuário e local ao navegador.** Sem login, sem RLS, sem dado compartilhado.
- **Sem backend.** O que vale em produção é o app em `src/` sobre o Supabase.
- **Mapa em SVG embutido.** A página não pode buscar tiles externos; no app real o mapa é
  Leaflet + OpenStreetMap (ver LG-09 no documento de roadmap).
- **Binário de anexo não é retido** entre recargas — apenas metadados e miniatura de
  imagem. No app real o arquivo vive no Supabase Storage.

## Paridade com o banco

A máquina de estados, os limiares de semáforo de SLA (75% / 90%), o score de fila e a
semântica do motor de mapeamento são cópias fiéis do que está em `supabase/migrations/`.
Divergir aqui tornaria a demonstração enganosa.
