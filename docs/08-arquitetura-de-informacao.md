# 08 — Arquitetura de informação: menu, nomenclatura e agrupamento

**Status:** implementado.
**Fonte única:** `src/lib/navigation.ts`. O protótipo (`demo/sti-tool.html`) carrega
uma cópia da estrutura, e `src/lib/permissions.demo.test.ts` cobra que as duas não
divirjam.

## 1. O problema

O menu era uma **lista plana de 16 itens**, e o roteiro previa 25. Lista plana
funciona até uns sete itens; passando disso, quem usa relê o menu inteiro toda vez
para achar um item, porque não existe ponto onde a vista descanse. Agrupar deixou
de ser questão de estética.

Havia também um defeito estrutural: a lista morava dentro de
`src/app/(app)/layout.tsx`, então `requireScreen()` não tinha como saber para onde
mandar quem fosse negado — mandava sempre para `/painel`. Como os perfis
financeiros não recebem o módulo de helpdesk, `/painel` negava e redirecionava
para `/painel`. **Um Aprovador Financeiro nunca conseguiria entrar no sistema.**

## 2. Princípios adotados

**Agrupar por trabalho, não por tabela.** Os grupos respondem "o que eu vim fazer
aqui": atender, cobrar e pagar, cuidar do parque, cadastrar, conectar,
administrar. Menu que espelha o modelo de dados obriga quem usa a conhecer o
modelo de dados.

**Sete grupos, no máximo.** É o teto prático de uma barra lateral que se lê de
relance. O que se usa todo dia fica no topo; configuração, no fim.

**Sempre expandido, sem acordeão.** O menu já chega filtrado por permissão: um
solicitante vê seis itens, não vinte e cinco. Acordeão custaria um clique para
alcançar qualquer coisa e criaria estado ("qual grupo estava aberto?") para
resolver um problema de altura que a filtragem já resolve. Onde a lista fica longa
— perfil de administrador — o cabeçalho de grupo é o que a vista usa para pular; e
escondido dentro de um acordeão ele não serviria para isso.

**Grupo vazio desaparece inteiro, cabeçalho incluído.** Cabeçalho sozinho anuncia
a existência de um módulo sem dar acesso a ele, e isso só gera pergunta para o
suporte.

**Destino fora de grupo.** `Visão geral` e `Minha conta` não têm cabeçalho: são
destino, não categoria.

## 3. A estrutura

| Grupo | Itens |
|---|---|
| — | Visão geral |
| **Atendimento** | Tickets · Abrir ticket · Filas · SLA e prazos |
| **Financeiro** | Títulos a pagar · Títulos a receber · Contas bancárias · Centros de custo · Fluxo de caixa |
| **Infraestrutura** | Inventário de TI · Telefonia · Links de internet · Mapa das filiais |
| **Cadastros** | Clientes e filiais · Fornecedores e contratos |
| **Integrações** | Sistemas de tickets · *Automação (N8N)* · *WhatsApp* · *Telegram* · *Bancos de dados* · *Pagamento bancário* · *Recebimento bancário* |
| **Administração** | Usuários · Perfis de acesso · Painéis de TV |
| — | Minha conta |

*Itálico* = previsto, sem tela ainda.

## 4. Nomenclatura: as decisões e o porquê

| Escolhido | Descartado | Motivo |
|---|---|---|
| **Títulos a pagar / a receber** | Contas a pagar / a receber | No mesmo grupo existe **Contas bancárias**. A palavra "contas" com dois sentidos a dois itens de distância é fonte de erro de leitura. "Título" é o termo que o financeiro brasileiro já usa. |
| **SLA e prazos** | SLA | Metade de quem abre a tela não sabe o que é a sigla. "Prazos" diz o que se vai encontrar. |
| **Mapa das filiais** | Mapas | "Mapas" não dizia o mapa de quê. |
| **Inventário de TI** | Inventário | Distingue de inventário de estoque, que não existe aqui e seria a suposição natural. |
| **Fornecedores e contratos** | Fornecedores | A tela tem as duas coisas, e o contrato era o que as pessoas não encontravam. |
| **Visão geral** | Painel, Dashboard | "Painel" já é usado em "Painéis de TV", e "Dashboard" é palavra de fora. |
| **Sistemas de tickets** | Integrações, Bitrix24 | O grupo já se chama Integrações; o item precisa dizer que TIPO de integração. Nomear pelo fornecedor amarraria o rótulo a um produto. |

**Ordem dentro do grupo não é ordem de construção.** No Financeiro, os títulos vêm
antes dos centros de custo: título se lança todo dia, centro de custo se cadastra
uma vez. É a única divergência da ordem em que o escopo listou os itens, e é
deliberada.

## 5. Itens previstos ("em breve")

Sete subgrupos de integração foram pedidos e **um existe**. Os outros seis entram
no menu marcados como previstos, por decisão tomada com o cliente: o menu passa a
comunicar o roteiro.

Os **seis previstos são hoje todos de Integrações**. *Fluxo de caixa* e *Links de
internet* saíram da lista: ganharam tela e chave própria nas migrações 0021 e 0022,
que é como um previsto deve terminar — a permissão entra junto com a tela, nunca
antes.

Três regras impedem que isso vire promessa vazia:

1. **Não recebem chave no catálogo de permissões.** Permissão que não governa tela
   é configuração morta — o administrador desmarca e nada acontece. Esse defeito
   já foi corrigido em seis chaves nesta base, e a regra existe para não repeti-lo.
2. **Não fazem o grupo aparecer sozinhos.** Sem pelo menos um item real
   alcançável, o grupo todo desaparece; senão um menu inteiro de promessas surgiria
   para quem não tem acesso a nada daquele módulo.
3. **Carregam a explicação.** Cada um tem um `hint` dizendo o que vai fazer e do
   que depende, exibido no `title`. "Em breve" sem prazo nem escopo é ruído.

São `<span>`, não `<button disabled>`: botão desabilitado sai da ordem de tabulação
sem explicar por quê, e leitor de tela anuncia "botão indisponível", que não
informa nada. Aqui o selo "em breve" está no texto lido.

## 6. A Visão geral

`/painel` deixou de ser "painel do helpdesk" e passou a ser a tela inicial de todo
mundo, com **blocos por módulo**: Financeiro, Atendimento, Infraestrutura. Cada
bloco exige a permissão do seu módulo, e nenhuma consulta é feita para bloco
invisível — além de não desperdiçar viagem ao banco, evita a leitura errada de "a
query voltou vazia" quando o certo é "esta pessoa não olha para isso".

O item de menu **não exige permissão**. Exigir `helpdesk.painel.ver` no destino
padrão era a causa raiz do laço de redirect; agora essa chave governa apenas o
bloco de atendimento dentro da página.

Quem não alcança bloco nenhum recebe um aviso explícito, em vez de uma tela vazia.

## 7. Como isso é verificado

| O que | Onde |
|---|---|
| Teto de 7 grupos, rótulo e href únicos, permissão existente no catálogo | `src/lib/navigation.test.ts` |
| Grupo desaparece inteiro; previsto não faz grupo aparecer; ordem preservada | `src/lib/navigation.test.ts` |
| Destino pós-negação nunca é tela negada, e nunca é `/conta` como 1ª opção | `src/lib/navigation.test.ts` |
| Estrutura do protótipo idêntica à da aplicação | `src/lib/permissions.demo.test.ts` |
| Comportamento em navegador: grupos, "em breve", separação de função | `demo/tests/prototipo.spec.mjs` |
| A projeção de caixa reage ao percentual, e só nas entradas | `demo/tests/prototipo.spec.mjs` §11 |
| Links some do menu de quem não tem `conectividade`; Operador de TI não cadastra | `demo/tests/prototipo.spec.mjs` §12 |

O teste de navegador não é enfeite: foi ele que achou `ROLE_RANK` invertido no
protótipo e as regras de perfil paradas antes da migração 0020 — dois defeitos cujo
sintoma era um **botão ausente**, não um erro.

## 8. Lacunas

- **`[LACUNA]` Busca global.** Com 25 itens, procurar pelo nome vale mais que
  navegar. Não implementada: exige indexar ticket, ativo, título e cliente, e a
  decisão de o que entra na busca é de produto.
- **`[LACUNA]` Favoritos ou itens recentes.** Quem usa três telas todo dia não
  deveria percorrer o menu. Depende de gravar preferência por usuário.
- **`[DECISÃO PENDENTE]` Barra compacta de celular.** Hoje é a lista plana sem
  grupos, porque cabeçalho de grupo numa tira horizontal ocuparia o espaço dos
  próprios itens. Com 25 itens ela fica longa; a alternativa é um menu em gaveta.
