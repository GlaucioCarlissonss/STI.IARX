// Package coleta monta o inventário da máquina.
package coleta

// As estruturas abaixo são o contrato com o servidor. Ele está escrito duas
// vezes — aqui e em `src/lib/agent/inventario.ts` — porque as duas pontas não
// compartilham código, e vão ter de ser mudadas juntas. O arquivo TypeScript é o
// documento normativo: ele é quem recusa um inventário malformado.
//
// Todo campo leva `omitempty`. Não é economia de bytes: o servidor calcula o
// hash do conteúdo para decidir se o inventário mudou, e um campo presente com
// valor vazio num dia e ausente no outro mudaria o hash sem nada ter mudado na
// máquina — gerando uma linha de histórico por dia com a mesma informação, que é
// o defeito que o hash existe para evitar.
//
// Pela mesma razão, NADA aqui carrega carimbo de hora. A hora da coleta viaja
// fora do objeto hasheado, em `coletado_em`.

type Sistema struct {
	Hostname      string `json:"hostname"`
	OS            string `json:"os,omitempty"`
	OSVersion     string `json:"os_version,omitempty"`
	OSBuild       string `json:"os_build,omitempty"`
	Chassi        string `json:"chassi,omitempty"`
	Fabricante    string `json:"fabricante,omitempty"`
	Modelo        string `json:"modelo,omitempty"`
	NumeroSerie   string `json:"numero_serie,omitempty"`
	ServiceTag    string `json:"service_tag,omitempty"`
	Dominio       string `json:"dominio,omitempty"`
	UsuarioLogado string `json:"usuario_logado,omitempty"`
}

/*
 * O TEMPO LIGADO NÃO ESTÁ AQUI, e a ausência custou um defeito para ser
 * descoberta.
 *
 * A primeira versão o tinha, com a justificativa de que "esta máquina está
 * ligada há 240 dias" é um fato de configuração (ninguém reinicia, então ninguém
 * aplica atualização) e não uma amostra de desempenho. O raciocínio sobre o
 * SIGNIFICADO estava certo; sobre a MECÂNICA, errado: o número muda a cada
 * segundo, e tudo neste arquivo é hasheado para decidir se o inventário mudou.
 *
 * O efeito era silencioso e total: TODA coleta produzia um hash diferente, então
 * toda coleta virava um snapshot novo. O histórico de "o que mudou nesta
 * máquina?" — que é a razão de a tabela existir — teria 365 linhas idênticas por
 * ano, por máquina.
 *
 * Quem pegou foi o teste de ponta a ponta do pacote `servico`, e só quando as
 * duas coletas caíam em segundos diferentes. Por isso há agora uma asserção
 * direta sobre a estabilidade do hash, em `coleta_test.go`.
 *
 * O tempo ligado vive em `Amostra.LigadaS`, na série temporal, que é onde um
 * número que muda sempre pertence.
 */

type Processador struct {
	Modelo        string `json:"modelo,omitempty"`
	Nucleos       int    `json:"nucleos,omitempty"`
	Threads       int    `json:"threads,omitempty"`
	FrequenciaMHz int    `json:"frequencia_mhz,omitempty"`
	Arquitetura   string `json:"arquitetura,omitempty"`
}

type Pente struct {
	Slot          string `json:"slot,omitempty"`
	TamanhoBytes  int64  `json:"tamanho_bytes,omitempty"`
	Tipo          string `json:"tipo,omitempty"`
	VelocidadeMHz int    `json:"velocidade_mhz,omitempty"`
	Fabricante    string `json:"fabricante,omitempty"`
}

type Memoria struct {
	TotalBytes int64   `json:"total_bytes,omitempty"`
	Pentes     []Pente `json:"pentes,omitempty"`
}

type Disco struct {
	Dispositivo  string `json:"dispositivo,omitempty"`
	Modelo       string `json:"modelo,omitempty"`
	TamanhoBytes int64  `json:"tamanho_bytes,omitempty"`
	Tipo         string `json:"tipo,omitempty"`
	// Saude resume o SMART em três estados. Os 30 atributos crus não respondem
	// "preciso trocar este disco?" para ninguém que não seja especialista, e é
	// essa a pergunta que a tela faz.
	Saude string `json:"saude,omitempty"`
}

// O inventário NÃO tem lista de volumes, e a ausência vale uma nota.
//
// A primeira versão tinha: `ponto`, `sistema_arquivos` e `total_bytes`, com o
// espaço livre deliberadamente de fora (livre é métrica, e mudaria o hash do
// inventário a cada coleta). Acontece que nenhum coletor chegou a preenchê-la —
// e, quando as métricas chegaram na Onda 3, elas já carregavam ponto e tamanho
// de cada volume a cada amostra.
//
// Ou seja: o campo não trazia nada que a série temporal não trouxesse, exceto o
// tipo de sistema de arquivos, que ninguém perguntou. Campo declarado e nunca
// preenchido é a mesma configuração morta que esta base já removeu seis vezes
// do catálogo de permissões, então ele saiu em vez de ser renomeado para dar
// lugar ao `Volume` das métricas.

type Rede struct {
	Nome string   `json:"nome,omitempty"`
	MAC  string   `json:"mac,omitempty"`
	IPs  []string `json:"ips,omitempty"`
	Tipo string   `json:"tipo,omitempty"`
}

type Video struct {
	Modelo       string `json:"modelo,omitempty"`
	MemoriaBytes int64  `json:"memoria_bytes,omitempty"`
	Driver       string `json:"driver,omitempty"`
}

type BIOS struct {
	Fabricante string `json:"fabricante,omitempty"`
	Versao     string `json:"versao,omitempty"`
	Data       string `json:"data,omitempty"`
	Modo       string `json:"modo,omitempty"`
	SecureBoot *bool  `json:"secure_boot,omitempty"`
}

type Programa struct {
	Nome        string `json:"nome"`
	Versao      string `json:"versao,omitempty"`
	Fabricante  string `json:"fabricante,omitempty"`
	InstaladoEm string `json:"instalado_em,omitempty"`
}

type Agente struct {
	Versao     string `json:"versao,omitempty"`
	Plataforma string `json:"plataforma,omitempty"`
}

type Inventario struct {
	Sistema     Sistema      `json:"sistema"`
	Processador *Processador `json:"processador,omitempty"`
	Memoria     *Memoria     `json:"memoria,omitempty"`
	Discos      []Disco      `json:"discos,omitempty"`
	Rede        []Rede       `json:"rede,omitempty"`
	Video       []Video      `json:"video,omitempty"`
	BIOS        *BIOS        `json:"bios,omitempty"`
	Software    []Programa   `json:"software,omitempty"`
	Agente      *Agente      `json:"agente,omitempty"`
}

// Envelope é o que vai no corpo da requisição.
type Envelope struct {
	ColetadoEm string     `json:"coletado_em"`
	Inventario Inventario `json:"inventario"`
}
