package atualizacao

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

/*
Estes testes cobrem o caminho que, se der errado, dá errado em duzentas máquinas
ao mesmo tempo, dentro da rede do cliente, com privilégio de serviço.

Nenhum deles chega a trocar o binário de verdade — para isso seria preciso um
executável assinado para a plataforma do teste. O que eles provam é que a
atualização é **recusada** em cada uma das formas de ela estar errada, que é a
metade que importa: uma atualização que não acontece é um agente desatualizado;
uma que acontece com o binário errado é um incidente.
*/

func chaveDeTeste(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

// comChave fixa a chave pública durante o teste e restaura depois.
func comChave(t *testing.T, pub ed25519.PublicKey) {
	t.Helper()
	anterior := ChavePublica
	ChavePublica = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() { ChavePublica = anterior })
}

func servirBinario(t *testing.T, conteudo []byte) *httptest.Server {
	t.Helper()
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(conteudo)
	}))
	// O servidor de teste usa certificado próprio, e o agente — corretamente —
	// recusa certificado que não confia. `s.Client()` é o cliente que confia
	// NESTE servidor e em mais nenhum.
	anterior := clienteSubstituto
	clienteSubstituto = s.Client()
	t.Cleanup(func() {
		clienteSubstituto = anterior
		s.Close()
	})
	return s
}

func TestSemChaveCompiladaNaoAtualiza(t *testing.T) {
	/*
	 * A salvaguarda mais importante do arquivo: o binário distribuído sem chave
	 * não TEM o recurso, em vez de ter o recurso com a verificação desligada.
	 *
	 * A diferença não é retórica. "Verificação desligada" é um estado que alguém
	 * liga por engano numa variável de ambiente; "recurso ausente" exige
	 * recompilar.
	 */
	anterior := ChavePublica
	ChavePublica = ""
	t.Cleanup(func() { ChavePublica = anterior })

	err := Aplicar(context.Background(), Publicacao{
		Versao: "9.9.9",
		URL:    "https://exemplo.invalido/agente",
		SHA256: strings.Repeat("a", 64),
	}, "1.0.0")

	if err == nil {
		t.Fatal("atualizou sem chave pública compilada")
	}
	if err != ErrSemChave {
		t.Fatalf("esperava ErrSemChave, veio: %v", err)
	}
}

func TestMesmaVersaoNaoFazNada(t *testing.T) {
	// Sem isto, o agente baixaria o próprio binário a cada ciclo — duzentas
	// máquinas puxando alguns megabytes duas vezes por dia, para nada.
	pub, _ := chaveDeTeste(t)
	comChave(t, pub)

	if err := Aplicar(context.Background(), Publicacao{Versao: "1.0.0"}, "1.0.0"); err != nil {
		t.Fatalf("mesma versão não devia tentar nada: %v", err)
	}
	if err := Aplicar(context.Background(), Publicacao{Versao: ""}, "1.0.0"); err != nil {
		t.Fatalf("publicação vazia não devia tentar nada: %v", err)
	}
}

func TestHashQueNaoBateRecusa(t *testing.T) {
	pub, priv := chaveDeTeste(t)
	comChave(t, pub)

	conteudo := []byte("binário de mentira")
	s := servirBinario(t, conteudo)
	assinatura := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, conteudo))

	err := Aplicar(context.Background(), Publicacao{
		Versao:     "9.9.9",
		URL:        s.URL,
		SHA256:     strings.Repeat("b", 64), // hash de outra coisa
		Assinatura: assinatura,
	}, "1.0.0")

	if err == nil {
		t.Fatal("aceitou um arquivo cujo hash não bate com o publicado")
	}
	if !strings.Contains(err.Error(), "hash") {
		t.Fatalf("o erro devia falar do hash, veio: %v", err)
	}
}

func TestAssinaturaDeOutraChaveRecusa(t *testing.T) {
	/*
	 * É o cenário que justifica a assinatura existir ao lado do hash: alguém que
	 * controla o servidor publica um binário e o hash CORRETO dele. Se só o hash
	 * fosse conferido, a verificação passaria — e "quem controla o servidor"
	 * inclui quem tiver acesso às variáveis de ambiente e qualquer intermediário
	 * que termine o TLS.
	 */
	pub, _ := chaveDeTeste(t)
	comChave(t, pub)

	_, outraPriv := chaveDeTeste(t) // o atacante assina com a chave dele
	conteudo := []byte("binário trocado, com hash honesto")
	s := servirBinario(t, conteudo)
	soma := sha256.Sum256(conteudo)

	err := Aplicar(context.Background(), Publicacao{
		Versao:     "9.9.9",
		URL:        s.URL,
		SHA256:     hex.EncodeToString(soma[:]),
		Assinatura: base64.StdEncoding.EncodeToString(ed25519.Sign(outraPriv, conteudo)),
	}, "1.0.0")

	if err == nil {
		t.Fatal("aceitou binário assinado por outra chave")
	}
	if !strings.Contains(err.Error(), "assinatura") {
		t.Fatalf("o erro devia falar da assinatura, veio: %v", err)
	}
}

func TestAssinaturaDoHashEmTextoNaoServe(t *testing.T) {
	/*
	 * A assinatura é sobre os BYTES DO BINÁRIO, não sobre o texto do hash.
	 *
	 * Assinar o texto do hash parece equivalente e não é: quem controlasse o
	 * servidor publicaria um hash qualquer com a assinatura correspondente, a
	 * verificação passaria, e o arquivo seria outro. Este teste prova que o
	 * atalho não funciona.
	 */
	pub, priv := chaveDeTeste(t)
	comChave(t, pub)

	conteudo := []byte("binário de mentira")
	s := servirBinario(t, conteudo)
	soma := sha256.Sum256(conteudo)
	hashTexto := hex.EncodeToString(soma[:])

	err := Aplicar(context.Background(), Publicacao{
		Versao:     "9.9.9",
		URL:        s.URL,
		SHA256:     hashTexto,
		Assinatura: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(hashTexto))),
	}, "1.0.0")

	if err == nil || !strings.Contains(err.Error(), "assinatura") {
		t.Fatalf("assinatura do texto do hash não pode valer; veio: %v", err)
	}
}

func TestURLSemHTTPSRecusa(t *testing.T) {
	// O download é verificado por assinatura de qualquer jeito. Permitir HTTP
	// convidaria alguém a publicar uma URL de teste em produção — e a URL de teste
	// é a que fica.
	pub, _ := chaveDeTeste(t)
	comChave(t, pub)

	err := Aplicar(context.Background(), Publicacao{
		Versao: "9.9.9",
		URL:    "http://exemplo.invalido/agente",
		SHA256: strings.Repeat("a", 64),
	}, "1.0.0")

	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("esperava recusa por não ser https, veio: %v", err)
	}
}

func TestChavePublicaMalformadaRecusa(t *testing.T) {
	anterior := ChavePublica
	ChavePublica = "isto não é base64 de 32 bytes"
	t.Cleanup(func() { ChavePublica = anterior })

	err := Aplicar(context.Background(), Publicacao{
		Versao: "9.9.9",
		URL:    "https://exemplo.invalido/a",
		SHA256: strings.Repeat("a", 64),
	}, "1.0.0")

	if err == nil || !strings.Contains(err.Error(), "chave pública") {
		t.Fatalf("esperava recusa por chave malformada, veio: %v", err)
	}
}

func TestApresentarExigeAVersaoAnunciada(t *testing.T) {
	/*
	 * O teste de sanidade: o binário candidato é executado e tem de dizer a versão
	 * que foi anunciada. Pega arquitetura errada, biblioteca faltando, antivírus
	 * que pôs o arquivo em quarentena — e publicação com o número de versão
	 * errado, que é o mais comum dos quatro.
	 */
	if runtime.GOOS == "windows" {
		t.Skip("o script de teste é um shell script")
	}

	dir := t.TempDir()
	falso := filepath.Join(dir, "agente-falso")
	if err := os.WriteFile(falso, []byte("#!/bin/sh\necho 2.0.0\n"), 0o755); err != nil { //nolint:gosec
		t.Fatal(err)
	}

	if err := apresentar(context.Background(), falso, "2.0.0"); err != nil {
		t.Fatalf("o binário disse a versão certa e foi recusado: %v", err)
	}
	if err := apresentar(context.Background(), falso, "3.0.0"); err == nil {
		t.Fatal("o binário disse 2.0.0 quando 3.0.0 foi anunciada, e passou")
	}

	mudo := filepath.Join(dir, "agente-mudo")
	if err := os.WriteFile(mudo, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil { //nolint:gosec
		t.Fatal(err)
	}
	if err := apresentar(context.Background(), mudo, "2.0.0"); err == nil {
		t.Fatal("binário que não roda tem de ser recusado ANTES da troca")
	}
}
