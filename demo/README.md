# Ferramenta navegável (protótipo de interface)

`sti-tool.html` é uma página autocontida com **as 48 telas do produto**: o ciclo do
chamado, o autoatendimento, a **locação de equipamento**, a gestão, o financeiro, o
inventário e a administração. Abra o arquivo direto no navegador — não precisa de servidor.

Ela serve para **mostrar o produto** a quem ainda não o comprou, e para avaliar
comportamento de tela sem subir nada.

> ### O defeito que esta rodada corrigiu, dito aqui porque ele pode voltar
>
> A aplicação chegou a 48 telas enquanto este arquivo ainda mostrava **25**. Faltava a
> **locação inteira** — frota, contratos, medições, faturamento, manutenção, peças,
> compras, contagens — e mais dezessete telas de gestão. Mais da metade do produto não
> existia no único artefato que se abre para mostrar o produto.
>
> E nada acusava: o catálogo de permissões estava em dia, as telas da aplicação estavam
> testadas, e a ferramenta abria bonita — só que menor. É o tipo de divergência que cresce
> em silêncio, uma entrega de cada vez, até alguém abrir o arquivo para demonstrar e sentir
> falta do que tinha antes.
>
> Agora existem dois testes para isso: `src/lib/navigation.demo.test.ts` falha quando o
> menu da aplicação ganha tela que este arquivo não tem, e a seção 15 de
> `tests/prototipo.spec.mjs` abre cada uma das 26 telas novas e confere que o **título**
> apareceu — tela ausente cai no fallback de "Novidades", que tem 4.500 caracteres e
> passaria por qualquer conferência de tamanho.

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
| **Perfis de acesso** | Os 9 perfis do sistema, a matriz módulo → tela → ação sobre as 108 chaves do catálogo, e "quem usa qual perfil" com o papel efetivo. Duplicar um perfil do sistema é o jeito de variá-lo sem quebrar quem o usa. |
| **Centros de custo** | Hierarquia até 3 níveis, com o 4º e o ciclo recusados. Centro de filial permite cobrar custo de TI por unidade. |
| **Contas bancárias** | Saldo derivado das movimentações, extrato consolidado, conciliação e transferência interna de dupla entrada. |

## Locação de equipamento — a esfera `rental`

O negócio de quem aluga equipamento próprio. O que separa estas telas das de gestão não é
o que elas fazem: é o **sentido do dinheiro**. Aqui ele entra — contrato + medição →
fatura → título a receber. Na gestão ele sai — nota de terceiro → título a pagar → orçamento.

| Tela | O que ela mostra, e por quê |
|---|---|
| **Frota** | O ciclo de vida como máquina de estados, cópia fiel da migração 0048: de "disponível" não se vai direto a "locado". **Bloqueio é atributo, não estado** — a peça bloqueada continua dizendo onde de fato está. |
| **Modelos e categorias** | O medidor padrão é **nenhum**: a maior parte do que se aluga é cobrada por tempo. Medidor obrigatório inventaria horímetro onde não existe. |
| **Contratos** | Item com preço e franquia próprios — o mesmo cliente negocia diferente para peças diferentes. O reajuste é **registrado, não calculado**: o sistema não tem a série do IPCA. |
| **Medições e consumo** | Leitura **sem contrato também é leitura**: a manutenção lê o medidor na entrada da oficina, e descartar o número abriria um buraco onde ele andou sem faturar. |
| **Faturamento** | A fatura **reemitida** aparece com sufixo (`…/202610-2`) e a cancelada continua na lista — cobrança enviada que some do sistema é conversa sem prova. |
| **Manutenção em campo** | Atendimento de campo **é chamado**, com ficha extra. Custo acima da alçada mostra **quem aprovou**: sem isso, "passou da alçada" e "ninguém viu" ficam idênticos. |
| **Peças e estoque** | O saldo é **derivado das movimentações**, nunca digitado. O ajuste de contagem entra como movimentação, e é o que mantém o extrato capaz de explicar o número. |
| **Ordens de compra** | **Receber não é dever**: a entrada no estoque é quando a mercadoria chega; o título a pagar nasce quando a nota é registrada. |
| **Contagens de inventário** | A divergência vira ajuste rastreável, e a semente traz uma de propósito — contagem que bate sempre não prova nada. |

## Gestão — as dezessete que faltavam

Portal, Expediente e feriados, Conversas, Base de conhecimento, Catálogo de serviços,
Visão de resultado, Projetos, Orçamento de TI, Agentes nas máquinas, Software instalado,
Sugestões de IA, Preferências do ambiente, Trilha de alterações, Trabalhos agendados,
Avisos enviados, Convites e Planilhas.

Três delas carregam decisões que valem ser vistas antes de comprar:

- **Trabalhos agendados** distingue *falhou* (houve execução e deu erro) de **PAROU** (não
  houve execução nenhuma) — e diz, na própria tela, que o alerta é disparado pela rota de
  trabalhos: se o agendador morrer por inteiro, o vigia dorme junto com o vigiado.
- **Sugestões de IA** mostra que a chave **não fica no banco** — o que fica é o nome da
  variável de ambiente. Um dump carrega os dados de todos os clientes; carregar junto a
  credencial transformaria vazamento de dados em vazamento de conta.
- **Avisos enviados** não mostra o corpo da mensagem: ele carrega o link de redefinição de
  senha de outra pessoa.

## O seletor "Foco" — esfera não é permissão

Ao lado de "Vendo como" há um segundo seletor, e ele responde a uma pergunta diferente.
Permissão responde *"esta pessoa pode abrir esta tela?"*; **esfera** responde *"esta tela
existe neste negócio?"*. Um gestor de TI com todas as permissões do mundo não deveria ver
"Medições e consumo".

O foco **não dá nem tira acesso**: escolher "Locação" tira Projetos do menu, não o projeto
— o endereço digitado continua abrindo, e há uma asserção que prova isso. Ele existe para
encurtar a barra de quem está num trabalho só.

> **Um achado que ficou em aberto.** Com as duas esferas a barra tem **9 grupos**, acima do
> teto prático de 7 para um menu que se lê de relance. Quem estourou o teto foi o produto,
> não o protótipo — a aplicação também tem 9. Com foco em locação a barra volta a 7; com
> foco em gestão fica em 8. "Autoatendimento" tem dois itens e caberia dentro de
> "Atendimento", mas isso é decisão de produto, e está registrada no teste em vez de ser
> resolvida por conta própria.

## O seletor "Vendo como" — é por aqui que se avalia a permissão

No topo da página há um seletor de sessão. Ele existe porque a camada de permissão não pode
ser avaliada lendo código: precisa ser vista mudando a interface.

Troque de **Ana Souza — Operador de TI** para **Diego Moreira — Operador Financeiro**: o menu
cai de nove itens para cinco, e em Contas bancárias sobra só o botão "Lançar" — sem "Nova
conta", sem "Transferir". Troque para **Elis Prado — Aprovador Financeiro** e não sobra botão
nenhum: a conciliação vira selo em vez de botão.

Diego e Elis têm o **mesmo papel** `gestor`. O que os separa é o perfil de acesso, e é
exatamente isso que o módulo de permissões existe para permitir — o papel sozinho não
distinguiria os dois, e as 138 policies de RLS não notariam diferença.

Se a tela aberta deixar de ser permitida na troca, a navegação cai no primeiro destino que a
sessão alcança, nunca numa tela negada. Essa regra não é enfeite: a versão de destino fixo
produziu um laço de redirect real na aplicação (`/painel` negava e redirecionava para
`/painel`), documentado em `../docs/07-financeiro-e-permissoes.md`.

## O que ela não é

- **Monousuário e local ao navegador.** Sem login, sem RLS, sem dado compartilhado. O seletor
  "Vendo como" troca de perfil **sem autenticar** — no app real quem determina o perfil é o
  JWT, não um `<select>`.
- **Esconder botão não é a barreira.** Aqui, como no app, o botão oculto é conveniência de
  interface; a recusa de verdade está na checagem antes da ação (`guard()` no protótipo,
  `requirePermission()` no Server Action) e, em produção, no RLS. Para conferir: abra o
  inspetor com o perfil da Elis, injete um botão `id="mv-new"`, clique — o formulário não
  abre e aparece "Sem permissão para esta ação."
- **Uma tela ficou sem permissão de propósito.** "Links de Internet" existe no protótipo e
  **não** tem chave no `PERMISSION_CATALOG`, porque a página equivalente ainda não existe na
  aplicação. Ela aparece para qualquer perfil, inclusive os do financeiro. Cadastrar a chave
  antes da tela produziria configuração que não governa nada — o defeito que esta rodada
  corrigiu em seis outras chaves. A própria tela avisa isso.
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

O catálogo de permissões **não é digitado à mão aqui**: é gerado de `src/lib/permissions.ts`,
e `src/lib/permissions.demo.test.ts` falha se as duas listas divergirem — chave nova só na
aplicação, chave inventada só no protótipo, ou teto de papel diferente. Protótipo que promete
um controle que a aplicação não tem é pior que protótipo sem controle. As concessões dos 9
perfis são expressas como **regra sobre o catálogo**, iguais às de
`app.seed_system_access_profiles` na migração 0017, e não como lista de chaves copiada.

A chave de `localStorage` é versionada (`sti.helpdesk.v6`). Um estado gravado por uma versão
anterior — sem perfis de acesso, centros de custo ou contas bancárias — é descartado em favor
do exemplo. Sem perfil a checagem de permissão nega tudo, e a ferramenta abriria sem menu
nenhum, sem causa visível.
