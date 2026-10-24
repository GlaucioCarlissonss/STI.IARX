// Package config guarda o que o agente precisa saber entre uma execução e outra.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config é o estado do agente em disco.
//
// Ele é separado em dois arquivos de propósito:
//
//   - agente.json — o que o instalador escreveu: servidor e token de inscrição.
//     Legível por quem administra a máquina, e é isso mesmo: o token de inscrição
//     é do lote, tem validade e teto de uso, e não serve para ler dado nenhum.
//
//   - identidade.json — o UUID da máquina e o token DELA. Permissão 0600, e é o
//     segredo de verdade: com ele se manda inventário em nome desta máquina.
//
// Juntar os dois num arquivo só pareceria simplificação e obrigaria a dar a
// permissão mais restrita ao arquivo que o instalador precisa escrever — ou, o
// que acontece na prática, a dar a permissão mais frouxa aos dois.
type Config struct {
	// Servidor é a origem, sem barra no fim: "https://sti.iartech.cloud".
	Servidor string `json:"servidor"`
	// TokenDeInscricao é usado UMA vez e depois fica inerte no arquivo.
	TokenDeInscricao string `json:"token_inscricao"`
	// IntervaloColetaMin é quanto tempo entre coletas de inventário.
	IntervaloColetaMin int `json:"intervalo_coleta_min"`
	// IntervaloEnvioMin é de quanto em quanto tempo a fila é esvaziada.
	IntervaloEnvioMin int `json:"intervalo_envio_min"`
	// IntervaloAmostraMin é de quanto em quanto tempo o desempenho é medido.
	IntervaloAmostraMin int `json:"intervalo_amostra_min"`
	/*
	 * Os serviços que esta máquina não pode ficar sem — nome CURTO, não o de
	 * exibição: o de exibição muda com o idioma do sistema, e uma configuração
	 * que funciona no Windows em português falharia calada no mesmo parque com
	 * uma máquina em inglês.
	 *
	 * Vazio é o padrão, e é deliberado: não existe lista de serviços críticos que
	 * sirva para todo mundo, e uma lista inventada por nós produziria alerta em
	 * máquina onde o serviço nunca deveria estar rodando.
	 */
	ServicosCriticos []string `json:"servicos_criticos"`
	// AutoAtualizar liga a verificação de versão nova.
	AutoAtualizar bool `json:"auto_atualizar"`
}

// Identidade é o que identifica esta máquina para o servidor.
type Identidade struct {
	DeviceUUID  string `json:"device_uuid"`
	DeviceToken string `json:"device_token"`
	DeviceID    string `json:"device_id"`
}

// Padrões. O intervalo de coleta é de um dia porque inventário de hardware muda
// poucas vezes por ano; o de envio é curto porque a fila precisa escoar logo
// depois de o notebook voltar para a rede.
const (
	ColetaPadraoMin = 24 * 60
	EnvioPadraoMin  = 10
	/*
	 * Cinco minutos entre amostras, e não um.
	 *
	 * Um minuto daria 288 mil linhas por dia numa frota de 200 máquinas; cinco
	 * dão 57 mil. A resolução de cinco minutos responde tudo que este módulo
	 * promete responder — "o disco encheu", "a máquina vive em 100% de CPU" — e
	 * a de um minuto só responde o que a plataforma não se propõe a investigar.
	 */
	AmostraPadraoMin = 5
	// Abaixo de um minuto a medição de CPU (que leva 200 ms a 3 s, conforme o
	// sistema) passaria a ser uma fração significativa do próprio intervalo.
	AmostraMinimaMin = 1
)

// DiretorioDeDados devolve onde o agente guarda estado, por sistema.
//
// Não é configurável de propósito. Um caminho vindo de variável de ambiente ou
// de linha de comando seria uma forma de fazer um serviço com privilégio
// escrever onde quem chamou escolhesse — e esse serviço escreve um arquivo que
// ele mesmo lê de volta e interpreta.
func DiretorioDeDados() string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "STI", "agente")
	case "darwin":
		return "/Library/Application Support/STI/agente"
	default:
		return "/var/lib/sti-agente"
	}
}

// Carregar lê a configuração, aplicando os padrões ao que faltar.
func Carregar() (Config, error) {
	caminho := filepath.Join(DiretorioDeDados(), "agente.json")
	bruto, err := os.ReadFile(caminho) //nolint:gosec // caminho fixo, não vem de entrada
	if err != nil {
		return Config{}, fmt.Errorf("lendo %s: %w", caminho, err)
	}

	var c Config
	if err := json.Unmarshal(bruto, &c); err != nil {
		return Config{}, fmt.Errorf("configuração malformada em %s: %w", caminho, err)
	}

	c.Servidor = strings.TrimRight(strings.TrimSpace(c.Servidor), "/")
	if c.Servidor == "" {
		return Config{}, errors.New("configuração sem 'servidor'")
	}
	if !strings.HasPrefix(c.Servidor, "https://") && !strings.HasPrefix(c.Servidor, "http://") {
		return Config{}, errors.New("'servidor' precisa começar com https://")
	}
	if c.IntervaloColetaMin <= 0 {
		c.IntervaloColetaMin = ColetaPadraoMin
	}
	if c.IntervaloEnvioMin <= 0 {
		c.IntervaloEnvioMin = EnvioPadraoMin
	}
	if c.IntervaloAmostraMin <= 0 {
		c.IntervaloAmostraMin = AmostraPadraoMin
	}
	if c.IntervaloAmostraMin < AmostraMinimaMin {
		c.IntervaloAmostraMin = AmostraMinimaMin
	}
	return c, nil
}

// CarregarIdentidade lê (ou cria) a identidade desta máquina.
//
// O UUID é gerado UMA vez, na primeira execução, e gravado. É a identidade
// estável da máquina: hostname muda quando o helpdesk renomeia o computador, e
// número de série vem vazio ou com texto de fábrica em placa branca e em máquina
// virtual. O UUID é a única coisa que atravessa reinstalação do agente — e é por
// isso que reinstalar não cria uma máquina duplicada no inventário.
func CarregarIdentidade() (Identidade, error) {
	dir := DiretorioDeDados()
	caminho := filepath.Join(dir, "identidade.json")

	bruto, err := os.ReadFile(caminho) //nolint:gosec // caminho fixo
	if err == nil {
		var id Identidade
		if err := json.Unmarshal(bruto, &id); err == nil && id.DeviceUUID != "" {
			return id, nil
		}
		// Arquivo ilegível: NÃO é apagado. Gerar outro UUID por cima criaria uma
		// segunda máquina no inventário e deixaria a primeira muda para sempre —
		// que é exatamente a duplicata que todo este desenho existe para evitar.
		return Identidade{}, fmt.Errorf("identidade ilegível em %s: conserte ou remova à mão", caminho)
	}
	if !os.IsNotExist(err) {
		return Identidade{}, fmt.Errorf("lendo identidade: %w", err)
	}

	uuid, err := uuidV4()
	if err != nil {
		return Identidade{}, err
	}
	id := Identidade{DeviceUUID: uuid}
	if err := SalvarIdentidade(id); err != nil {
		return Identidade{}, err
	}
	return id, nil
}

// SalvarIdentidade grava com permissão restrita, e por troca atômica.
//
// A gravação é em arquivo temporário seguido de rename porque o token da máquina
// é o único segredo que ela tem: uma queda de energia no meio de um `os.WriteFile`
// deixaria o arquivo truncado, e o agente acordaria sem credencial e sem saber
// qual era o UUID. O rename, nos três sistemas, ou acontece inteiro ou não
// acontece.
func SalvarIdentidade(id Identidade) error {
	dir := DiretorioDeDados()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("criando %s: %w", dir, err)
	}

	bruto, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}

	temp := filepath.Join(dir, "identidade.json.novo")
	if err := os.WriteFile(temp, bruto, 0o600); err != nil {
		return fmt.Errorf("gravando identidade: %w", err)
	}
	if err := os.Rename(temp, filepath.Join(dir, "identidade.json")); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("trocando identidade: %w", err)
	}
	return nil
}

// uuidV4 sem dependência externa. São 16 bytes aleatórios com os quatro bits de
// versão e os dois de variante fixados pela RFC 4122.
func uuidV4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("gerando identidade: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32]), nil
}
