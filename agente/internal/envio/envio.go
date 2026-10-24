// Package envio fala com o servidor.
package envio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrCredencialMorta diz que o token desta máquina não vale mais.
//
// É um erro à parte porque exige uma reação diferente de todos os outros: não
// adianta tentar de novo. Ou a máquina foi revogada (e deve parar), ou o token
// foi rotacionado por uma reinstalação (e ela deve se reinscrever). Tratar isso
// como "erro de rede" faria o agente repetir a mesma credencial recusada a cada
// dez minutos, para sempre, em silêncio.
var ErrCredencialMorta = errors.New("o token desta máquina não é mais aceito")

type Cliente struct {
	servidor string
	http     *http.Client
	versao   string
}

func Novo(servidor, versaoDoAgente string) *Cliente {
	return &Cliente{
		servidor: servidor,
		versao:   versaoDoAgente,
		http: &http.Client{
			/*
			 * Um minuto, e não os trinta segundos de costume: o envio do
			 * inventário carrega a lista de programas, e uma estação com milhares
			 * de pacotes numa ADSL de filial passa de trinta segundos. O timeout
			 * cobre a requisição inteira, incluindo a leitura da resposta.
			 */
			Timeout: 60 * time.Second,
		},
	}
}

type RespostaDeInscricao struct {
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
	TenantID    string `json:"tenant_id"`
}

// Inscrever troca o token do lote pelo token desta máquina.
func (c *Cliente) Inscrever(ctx context.Context, tokenDoLote string, device map[string]string) (RespostaDeInscricao, error) {
	corpo := map[string]any{"enrollment_token": tokenDoLote, "device": device}
	resp, err := c.post(ctx, "/api/agent/enroll", corpo, "")
	if err != nil {
		return RespostaDeInscricao{}, err
	}

	var r RespostaDeInscricao
	if err := json.Unmarshal(resp, &r); err != nil {
		return RespostaDeInscricao{}, fmt.Errorf("resposta de inscrição ilegível: %w", err)
	}
	if r.DeviceToken == "" {
		return RespostaDeInscricao{}, errors.New("o servidor aceitou a inscrição mas não devolveu o token")
	}
	return r, nil
}

type RespostaDeInventario struct {
	Status     string `json:"status"`
	AssetID    string `json:"asset_id"`
	SnapshotID string `json:"snapshot_id"`
}

// EnviarInventario manda um envelope já serializado.
//
// Ele recebe bytes e não uma estrutura porque quem chama é o esvaziamento da
// fila, que leu o arquivo do disco. Desserializar para serializar de novo só
// gastaria tempo e abriria a chance de a versão nova do agente mudar o formato
// de um envelope que a versão anterior gravou.
func (c *Cliente) EnviarInventario(ctx context.Context, token string, envelope []byte) (RespostaDeInventario, error) {
	resp, err := c.postBruto(ctx, "/api/agent/inventory", envelope, token)
	if err != nil {
		return RespostaDeInventario{}, err
	}
	var r RespostaDeInventario
	if err := json.Unmarshal(resp, &r); err != nil {
		return RespostaDeInventario{}, fmt.Errorf("resposta ilegível: %w", err)
	}
	return r, nil
}

// Batimento é o sinal de vida: algumas centenas de bytes, sem corpo.
func (c *Cliente) Batimento(ctx context.Context, token string) error {
	_, err := c.postBruto(ctx, "/api/agent/heartbeat", nil, token)
	return err
}

type RespostaDeMetricas struct {
	Status  string `json:"status"`
	Aceitas int    `json:"aceitas"`
}

// EnviarMetricas manda um lote de amostras já serializadas.
//
// `aceitas` pode voltar menor que o enviado, e isso NÃO é erro: amostra repetida
// (reenvio do lote) e amostra com relógio errado são descartadas pelo servidor de
// propósito. Quem chama esvazia a fila local pela resposta 200, e não pelo
// número — reenviar o que foi legitimamente descartado seria um laço que não
// termina.
func (c *Cliente) EnviarMetricas(ctx context.Context, token string, amostras []json.RawMessage) (RespostaDeMetricas, error) {
	corpo, err := json.Marshal(map[string]any{"amostras": amostras})
	if err != nil {
		return RespostaDeMetricas{}, err
	}
	resp, err := c.postBruto(ctx, "/api/agent/metrics", corpo, token)
	if err != nil {
		return RespostaDeMetricas{}, err
	}
	var r RespostaDeMetricas
	if err := json.Unmarshal(resp, &r); err != nil {
		return RespostaDeMetricas{}, fmt.Errorf("resposta de métricas ilegível: %w", err)
	}
	return r, nil
}

// RegistrarIdRemoto grava o id desta máquina no serviço de acesso remoto.
func (c *Cliente) RegistrarIdRemoto(ctx context.Context, token, id string) error {
	_, err := c.post(ctx, "/api/agent/remote-id", map[string]string{"remote_id": id}, token)
	return err
}

type Publicacao struct {
	Versao          string `json:"versao"`
	URL             string `json:"url"`
	SHA256          string `json:"sha256"`
	Assinatura      string `json:"assinatura"`
	CheckarACadaMin int    `json:"checar_a_cada_min"`
}

// VersaoPublicada devolve `nil` quando não há publicação — que não é erro.
func (c *Cliente) VersaoPublicada(ctx context.Context) (*Publicacao, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.servidor+"/api/agent/version", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "sti-agente/"+c.versao)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	// 204: não há versão publicada. É o estado normal de quem não configurou a
	// autoatualização, e a autoatualização ser fechada por padrão é deliberado.
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("consulta de versão respondeu %d", resp.StatusCode)
	}

	var p Publicacao
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (c *Cliente) post(ctx context.Context, caminho string, corpo any, token string) ([]byte, error) {
	bruto, err := json.Marshal(corpo)
	if err != nil {
		return nil, err
	}
	return c.postBruto(ctx, caminho, bruto, token)
}

func (c *Cliente) postBruto(ctx context.Context, caminho string, corpo []byte, token string) ([]byte, error) {
	var leitor io.Reader
	if corpo != nil {
		leitor = bytes.NewReader(corpo)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.servidor+caminho, leitor)
	if err != nil {
		return nil, err
	}
	if corpo != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("User-Agent", "sti-agente/"+c.versao)
	req.Header.Set("X-Agent-Version", c.versao)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	// 1 MB basta para qualquer resposta desta API, e o limite existe porque o
	// agente não controla o que está do outro lado — um proxy mal configurado
	// devolvendo uma página de erro de 50 MB não pode estourar a memória de um
	// serviço que roda em máquina de usuário.
	lido, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, ErrCredencialMorta
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return lido, nil
	default:
		/* A mensagem do servidor entra no erro porque ela é escrita para ser lida
		   por quem opera — as rotas de agente nunca devolvem detalhe interno. */
		return nil, fmt.Errorf("servidor respondeu %d: %s", resp.StatusCode, primeiraLinha(lido))
	}
}

func primeiraLinha(b []byte) string {
	const maximo = 200
	s := string(b)
	if i := bytes.IndexByte(b, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > maximo {
		s = s[:maximo] + "…"
	}
	return s
}
