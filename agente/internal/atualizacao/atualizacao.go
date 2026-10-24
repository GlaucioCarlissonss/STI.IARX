// Package atualizacao troca o binário do agente, com verificação de assinatura.
package atualizacao

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

/*
A autoatualização, e por que ela é a parte mais conservadora deste programa.

Duzentas máquinas não se atualizam à mão. E um agente que se atualiza errado é um
incidente em duzentos lugares ao mesmo tempo, dentro da rede do cliente, com
privilégio de serviço, e sem ninguém para apertar um botão em nenhum deles.

Os dois lados do risco são grandes e o segundo é maior. Por isso:

 1. **Sem chave pública compilada, não atualiza.** Nunca. O binário distribuído
    sem chave simplesmente não tem este recurso, em vez de ter o recurso com a
    verificação desligada — que é o jeito clássico de uma salvaguarda sumir.

 2. **A assinatura é verificada, não só o hash.** Se só o hash fosse conferido,
    quem controlasse o servidor controlaria o binário que roda como SYSTEM em
    todas as máquinas do cliente. E "quem controla o servidor" inclui quem tiver
    acesso às variáveis de ambiente, quem fizer um ataque de DNS e qualquer
    intermediário que termine o TLS. A assinatura move a confiança do servidor
    para a chave privada, que fica fora dele.

 3. **O binário novo tem de se apresentar antes de assumir.** Ele é executado com
    `--versao` e precisa responder a versão anunciada. Um executável que não roda
    na máquina — falta de biblioteca, antivírus que o colocou em quarentena,
    arquitetura errada — é descoberto AQUI, com o binário antigo ainda no lugar.

 4. **O anterior é guardado.** Se a troca falhar no meio, há para onde voltar.
*/

// ChavePublica é fixada na compilação:
//
//	go build -ldflags "-X .../atualizacao.ChavePublica=<base64 da chave Ed25519>"
//
// Vazia de propósito no código: a chave de uma distribuição real não mora no
// repositório, e um valor de exemplo aqui seria a coisa que alguém esqueceria de
// trocar.
var ChavePublica = ""

var ErrSemChave = errors.New("binário compilado sem chave pública: autoatualização desligada")

type Publicacao struct {
	Versao     string
	URL        string
	SHA256     string
	Assinatura string
}

// Aplicar baixa, verifica e troca o executável. Devolve `nil` se não havia o que
// fazer.
func Aplicar(ctx context.Context, p Publicacao, versaoAtual string) error {
	if p.Versao == "" || p.Versao == versaoAtual {
		return nil
	}
	if ChavePublica == "" {
		return ErrSemChave
	}

	chave, err := base64.StdEncoding.DecodeString(strings.TrimSpace(ChavePublica))
	if err != nil || len(chave) != ed25519.PublicKeySize {
		return fmt.Errorf("chave pública inválida no binário: %w", err)
	}

	// --- Baixar -------------------------------------------------------------
	bruto, err := baixar(ctx, p.URL)
	if err != nil {
		return err
	}

	// --- Conferir o hash ----------------------------------------------------
	soma := sha256.Sum256(bruto)
	if !strings.EqualFold(hex.EncodeToString(soma[:]), strings.TrimSpace(p.SHA256)) {
		return errors.New("o arquivo baixado não bate com o hash publicado")
	}

	// --- Conferir a assinatura ----------------------------------------------
	// A assinatura é sobre os BYTES DO BINÁRIO, não sobre o hash em texto. Assinar
	// o texto do hash deixaria quem controla o servidor livre para publicar um
	// hash qualquer com a assinatura correspondente — a verificação passaria, e
	// o arquivo seria outro.
	assinatura, err := base64.StdEncoding.DecodeString(strings.TrimSpace(p.Assinatura))
	if err != nil {
		return fmt.Errorf("assinatura ilegível: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(chave), bruto, assinatura) {
		return errors.New("a assinatura do binário não confere: atualização recusada")
	}

	// --- Instalar ao lado ---------------------------------------------------
	atual, err := os.Executable()
	if err != nil {
		return fmt.Errorf("descobrindo o próprio caminho: %w", err)
	}
	atual, err = filepath.EvalSymlinks(atual)
	if err != nil {
		return err
	}

	novo := atual + ".novo"
	// 0755 e não 0700: em Windows o modo é ignorado; em Unix o binário de um
	// serviço precisa ser executável por quem o serviço roda, que nem sempre é
	// quem o escreveu.
	if err := os.WriteFile(novo, bruto, 0o755); err != nil { //nolint:gosec // é um executável
		return fmt.Errorf("gravando a versão nova: %w", err)
	}

	// --- Exigir que ele se apresente ----------------------------------------
	if err := apresentar(ctx, novo, p.Versao); err != nil {
		_ = os.Remove(novo)
		return fmt.Errorf("a versão nova não passou no teste de sanidade: %w", err)
	}

	// --- Trocar, guardando o anterior ---------------------------------------
	anterior := atual + ".anterior"
	_ = os.Remove(anterior)
	if err := os.Rename(atual, anterior); err != nil {
		_ = os.Remove(novo)
		return fmt.Errorf("guardando a versão atual: %w", err)
	}
	if err := os.Rename(novo, atual); err != nil {
		// Volta atrás. Este é o caminho que não pode falhar em silêncio: sem ele,
		// a máquina ficaria sem binário nenhum no lugar do serviço.
		_ = os.Rename(anterior, atual)
		_ = os.Remove(novo)
		return fmt.Errorf("instalando a versão nova (revertido): %w", err)
	}

	return nil
}

// apresentar roda o candidato e exige que ele diga a versão esperada.
//
// É o teste mais barato que detecta as falhas mais comuns de uma atualização
// binária: arquitetura errada, biblioteca faltando, antivírus que pôs o arquivo
// em quarentena, download corrompido de um jeito que o hash não pegou (não
// acontece) ou publicação com o número de versão errado (acontece).
func apresentar(ctx context.Context, caminho, versaoEsperada string) error {
	c, cancelar := context.WithTimeout(ctx, 30*time.Second)
	defer cancelar()

	cmd := exec.CommandContext(c, caminho, "--versao")
	cmd.Env = []string{}
	saida, err := cmd.Output()
	if err != nil {
		return err
	}
	dito := strings.TrimSpace(string(saida))
	if dito != versaoEsperada {
		return fmt.Errorf("anunciada %q, respondeu %q", versaoEsperada, dito)
	}
	return nil
}

// clienteSubstituto existe para o teste poder servir o binário por TLS com
// certificado próprio.
//
// Ele é uma variável de pacote não exportada, e não um parâmetro de `Aplicar`,
// porque um parâmetro seria uma porta: quem chamasse a função passando um cliente
// com `InsecureSkipVerify` desligaria a verificação de certificado da
// atualização, e esse é o tipo de atalho que entra "só no ambiente de
// homologação" e fica. Variável de pacote não exportada só é alcançável de
// dentro do pacote — ou seja, pelos testes.
//
// A verificação de certificado NÃO é supérflua por existir a assinatura: sem TLS
// confiável, um intermediário vê para onde a máquina baixa e com que frequência,
// e consegue negar a atualização indefinidamente.
var clienteSubstituto *http.Client

func clienteDeDownload() *http.Client {
	if clienteSubstituto != nil {
		return clienteSubstituto
	}
	return &http.Client{Timeout: 10 * time.Minute}
}

func baixar(ctx context.Context, url string) ([]byte, error) {
	// Só HTTPS. O download é verificado por assinatura de qualquer jeito, mas
	// permitir HTTP convidaria alguém a publicar uma URL de teste em produção, e
	// a URL de teste é a que fica.
	if !strings.HasPrefix(url, "https://") {
		return nil, errors.New("a URL da atualização precisa ser https")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := clienteDeDownload().Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download respondeu %d", resp.StatusCode)
	}
	// 200 MB de teto: o agente tem poucos megabytes, e um servidor comprometido
	// ou mal configurado não pode encher o disco da máquina do cliente.
	return io.ReadAll(io.LimitReader(resp.Body, 200<<20))
}

// Alvo descreve esta máquina, para quem publica saber qual binário serve.
func Alvo() string { return runtime.GOOS + "/" + runtime.GOARCH }
