# Ferramenta navegável (protótipo de interface)

`sti-tool.html` é uma página autocontida que implementa a **interface** das 11 melhorias
especificadas em [../docs/06-lacunas-e-roadmap.md](../docs/06-lacunas-e-roadmap.md) e dos
**cadastros administrativos** portados do app Next.js.

Serve para avaliar e demonstrar o comportamento das telas antes de portá-las para o app
Next.js. Abra o arquivo direto no navegador — não precisa de servidor.

## O que ela é

Operacional de verdade: abrir ticket, mover status pela máquina de estados, transferir em
massa com motivo, editar SLA com preview de impacto, gerenciar áreas por filial, anexar
documentos e fotos, registrar custódia, cadastrar linhas e links, editar mapeamento de
integração com dry run, e navegar os mapas por filial. Tudo persiste em `localStorage`.

Os cadastros administrativos (telas marcadas como **novo** no menu) cobrem:

| Tela | O que dá para fazer |
|---|---|
| **Clientes e filiais** | Cadastrar, editar e inativar cliente e filial. CNPJ único, UF de 2 letras, fuso e calendário por filial. Filial nova nasce com as 8 áreas padrão. |
| **Fornecedores** | Cadastrar, editar e inativar fornecedor com serviços e avaliação (0–5), e os contratos: número, vigência, custo e **SLA contratado** — o prazo que o terceiro nos deve. |
| **SLA e filas** | Categorias em 2 níveis, prioridades (peso, cor, ordem), contratos de SLA por cliente e as definições. A prioridade nova aparece na hora ao abrir ticket. |
| **Usuários** | Criar conta com papel e filiais visíveis; a senha temporária é mostrada **uma única vez**. |
| **Minha conta** | Trocar a própria senha — é a saída da senha temporária. |
| **Inventário / Telefonia** | Editar a ficha do ativo e da linha, além do que já havia (custódia, anexos, status). |

## O que ela não é

- **Monousuário e local ao navegador.** Sem login, sem RLS, sem dado compartilhado.
- **Sem backend.** O que vale em produção é o app em `src/` sobre o Supabase.
- **A senha não é trocada de verdade.** Em "Minha conta" a validação roda (8 caracteres,
  confirmação) mas nada é gravado: no app real a troca vai para o Supabase Auth, e é
  justamente esse trecho que não tem como ser exercitado sem um projeto Supabase.
- **Mapa vetorial embutido, não tiles.** O mapa é de verdade — arrasta, dá zoom, agrupa
  marcadores e desenha as 27 UFs a partir da geometria do IBGE simplificada (~30 KB),
  projetada em Mercator, a mesma projeção do Google. O que ele não faz é buscar *tile* de
  imagem: a página é autocontida e o CSP dela bloqueia host externo. No app real, `/mapas`
  usa a Maps JavaScript API do Google com tiles (ADR de LG-09 no roadmap).
- **Binário de anexo não é retido** entre recargas — apenas metadados e miniatura de
  imagem. No app real o arquivo vive no Supabase Storage.

## Paridade com o banco

A máquina de estados, os limiares de semáforo de SLA (75% / 90%), o score de fila, a
semântica do motor de mapeamento e as regras dos cadastros (profundidade máxima de 2 níveis
em categoria, unicidade de contrato × categoria × prioridade no SLA, data obrigatória ao
cancelar linha, vigência final não anterior ao início) são cópias fiéis do que está em
`supabase/migrations/`. Divergir aqui tornaria a demonstração enganosa.

A chave de `localStorage` é versionada (`sti.helpdesk.v5`). Um estado gravado por uma versão
anterior — sem as coleções de cliente, fornecedor, categoria, prioridade e usuário — é
descartado em favor do exemplo, em vez de abrir as telas de cadastro vazias sem explicação.
