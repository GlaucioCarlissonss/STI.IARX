// O agente não tem dependência nenhuma além da biblioteca padrão, e isso é uma
// decisão, não uma falta.
//
// Ele roda como serviço, com privilégio, em computador de cliente — onde nem eu
// nem quem opera o sistema consegue inspecionar nada depois de instalado. Cada
// módulo de terceiro nessa posição é uma superfície que alguém teria de auditar
// a cada atualização, e ninguém audita. A biblioteca padrão do Go já traz HTTP,
// TLS, JSON, Ed25519 e SHA-256, que é tudo o que este programa precisa.
//
// O custo é real e está pago: a coleta no Windows usa PowerShell em vez de uma
// biblioteca de WMI, e a leitura do registro passa pela linha de comando. É mais
// verboso. Em troca, o binário é um arquivo só, sem runtime para instalar, e a
// árvore de dependências cabe em zero linhas.
module github.com/iartech/sti-agente

go 1.22
