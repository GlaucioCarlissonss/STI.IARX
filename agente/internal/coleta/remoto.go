package coleta

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

/*
O id desta máquina no serviço de acesso remoto.

## O que esta função faz, e o que ela não faz

Ela LÊ um id que outro programa já gerou. Ela não instala o RustDesk, não o
configura e não abre conexão nenhuma — controle remoto de tela é um produto
inteiro (NAT traversal, relay, codec, latência, segurança), e construí-lo aqui
custaria meses para entregar pior que uma ferramenta open source madura.

O pedaço que só esta plataforma pode fazer é saber **qual id pertence a qual
máquina do inventário**. É o elo que falta entre as duas ferramentas, e é barato.

## Por que RustDesk e por que só ele, por enquanto

Ele grava o id num arquivo de configuração em texto, em caminho previsível, nas
três plataformas. O MeshCentral identifica a máquina por um id gerado no servidor
e guardado no banco DELE — ler isso exigiria falar com a API do MeshCentral, com
credencial, o que é outro recurso e não cabe no agente.

Quando não há nada para ler, a função devolve vazio e o recurso simplesmente não
aparece na tela. Nenhum erro, nenhum aviso: a maioria das instalações não usa
acesso remoto, e avisar sobre a ausência de um recurso opcional é ruído.
*/

// IdDeAcessoRemoto devolve o id do RustDesk, ou vazio.
func IdDeAcessoRemoto() string {
	for _, caminho := range caminhosDoRustDesk() {
		bruto, err := os.ReadFile(caminho) //nolint:gosec // caminhos fixos de configuração
		if err != nil {
			continue
		}
		if id := idNoTOML(string(bruto)); id != "" {
			return id
		}
	}
	return ""
}

func caminhosDoRustDesk() []string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return []string{filepath.Join(base, "RustDesk", "config", "RustDesk.toml")}
	case "darwin":
		return []string{"/Library/Preferences/com.carriez.RustDesk/RustDesk.toml"}
	default:
		return []string{
			"/root/.config/rustdesk/RustDesk.toml",
			"/var/lib/rustdesk-server/RustDesk.toml",
			"/etc/rustdesk/RustDesk.toml",
		}
	}
}

// idNoTOML extrai `id = '123456789'` sem decodificar TOML.
//
// Um decodificador de TOML seria uma dependência (ver o `go.mod`) para ler uma
// linha de um arquivo cujo formato é estável há anos. A busca pela chave é
// literal e tolerante a aspas simples, duplas e espaço — e, se o formato mudar,
// a função devolve vazio e o recurso some, em vez de o agente quebrar.
func idNoTOML(conteudo string) string {
	for _, linha := range strings.Split(conteudo, "\n") {
		linha = strings.TrimSpace(linha)
		if strings.HasPrefix(linha, "#") {
			continue
		}
		chave, valor, achou := strings.Cut(linha, "=")
		if !achou || strings.TrimSpace(chave) != "id" {
			continue
		}
		valor = strings.TrimSpace(valor)
		valor = strings.Trim(valor, `'"`)
		// O id do RustDesk é numérico de 9 ou 10 dígitos. O teste de comprimento
		// evita devolver um valor de uma chave `id` de outra seção do arquivo.
		if len(valor) >= 6 && len(valor) <= 32 {
			return valor
		}
	}
	return ""
}
