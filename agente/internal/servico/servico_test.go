package servico

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/iartech/sti-agente/internal/config"
)

/*
Este é o teste que prova que o agente funciona — o laço inteiro, na máquina de
verdade, contra um servidor que responde como o real.

Os testes de unidade dos outros pacotes cobrem cada peça; nenhum deles pegaria o
erro que mais acontece nesta classe de programa: as peças certas ligadas na ordem
errada. Agente que coleta e não envia, que envia e não remove da fila (e reenvia
para sempre), que se inscreve e não grava o token (e se reinscreve a cada ciclo).

Ele escreve no diretório de dados de verdade (`/var/lib/sti-agente` no Linux),
porque esse caminho não é configurável — de propósito, ver `config.DiretorioDeDados`.
É por isso que ele limpa o que criou.
*/

type servidorDeMentira struct {
	mu          sync.Mutex
	inscricoes  int
	inventarios []map[string]any
	batimentos  int
	metricas    []map[string]any
	remotoID    string
	// negarToken faz o servidor responder 401, como se a máquina tivesse sido
	// revogada.
	negarToken bool
	*httptest.Server
}

func novoServidor(t *testing.T) *servidorDeMentira {
	t.Helper()
	s := &servidorDeMentira{}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/agent/enroll", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.inscricoes++
		if s.negarToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"device_id":"d1","device_token":"ag_do_teste","tenant_id":"t1"}`))
	})
	mux.HandleFunc("/api/agent/inventory", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.negarToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		bruto, _ := io.ReadAll(r.Body)
		var env map[string]any
		_ = json.Unmarshal(bruto, &env)
		s.inventarios = append(s.inventarios, env)
		_, _ = w.Write([]byte(`{"status":"stored","asset_id":"a1","snapshot_id":"s1"}`))
	})
	mux.HandleFunc("/api/agent/metrics", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.negarToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		bruto, _ := io.ReadAll(r.Body)
		var lote map[string]any
		_ = json.Unmarshal(bruto, &lote)
		s.metricas = append(s.metricas, lote)
		n := 0
		if as, ok := lote["amostras"].([]any); ok {
			n = len(as)
		}
		_, _ = w.Write([]byte(`{"status":"stored","aceitas":` + strconv.Itoa(n) + `}`))
	})
	mux.HandleFunc("/api/agent/remote-id", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		bruto, _ := io.ReadAll(r.Body)
		var corpo map[string]string
		_ = json.Unmarshal(bruto, &corpo)
		s.remotoID = corpo["remote_id"]
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/api/agent/heartbeat", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.negarToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		s.batimentos++
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func (s *servidorDeMentira) contagens() (int, int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inscricoes, len(s.inventarios), s.batimentos
}

// prepararDiretorio limpa o diretório de dados e devolve uma config apontando
// para o servidor de mentira.
func prepararDiretorio(t *testing.T, servidor string) config.Config {
	t.Helper()
	dir := config.DiretorioDeDados()

	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Skipf("sem permissão para escrever em %s: %v", dir, err)
	}
	limpar := func() {
		_ = os.RemoveAll(filepath.Join(dir, "fila"))
		_ = os.Remove(filepath.Join(dir, "metricas.jsonl"))
		_ = os.Remove(filepath.Join(dir, "identidade.json"))
		_ = os.Remove(filepath.Join(dir, "agente.json"))
	}
	limpar()
	t.Cleanup(limpar)

	cfg := config.Config{
		Servidor:            servidor,
		TokenDeInscricao:    "inv_do_teste",
		IntervaloColetaMin:  1440,
		IntervaloEnvioMin:   10,
		IntervaloAmostraMin: 5,
	}
	bruto, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(dir, "agente.json"), bruto, 0o600); err != nil {
		t.Skipf("sem permissão para escrever a configuração: %v", err)
	}
	return cfg
}

func TestOLacoCompleto(t *testing.T) {
	srv := novoServidor(t)
	cfg := prepararDiretorio(t, srv.URL)

	// A configuração é relida do disco, e não usada da struct: é o caminho que o
	// serviço de verdade percorre.
	lida, err := config.Carregar()
	if err != nil {
		t.Fatalf("configuração gravada não foi lida de volta: %v", err)
	}
	if lida.Servidor != cfg.Servidor {
		t.Fatalf("servidor lido %q, esperava %q", lida.Servidor, cfg.Servidor)
	}

	id, err := config.CarregarIdentidade()
	if err != nil {
		t.Fatal(err)
	}
	if id.DeviceUUID == "" {
		t.Fatal("a primeira execução tem de gerar o UUID da máquina")
	}
	if id.DeviceToken != "" {
		t.Fatal("máquina recém-nascida não pode já ter token")
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s, err := Novo(lida, id, log)
	if err != nil {
		t.Fatal(err)
	}

	// --- Primeiro ciclo: inscreve, coleta, envia, bate --------------------
	ctx, cancelar := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancelar()
	s.UmaVez(ctx)

	inscricoes, inventarios, batimentos := srv.contagens()
	if inscricoes != 1 {
		t.Fatalf("esperava 1 inscrição, houve %d", inscricoes)
	}
	if inventarios != 1 {
		t.Fatalf("esperava 1 inventário entregue, houve %d", inventarios)
	}
	if batimentos != 1 {
		t.Fatalf("esperava 1 batimento, houve %d", batimentos)
	}

	// O envelope precisa carregar a hora FORA do inventário.
	env := srv.inventarios[0]
	if _, tem := env["coletado_em"]; !tem {
		t.Error("o envelope não trouxe coletado_em")
	}
	inv, ok := env["inventario"].(map[string]any)
	if !ok {
		t.Fatal("o envelope não trouxe o inventário")
	}
	if _, vazou := inv["coletado_em"]; vazou {
		t.Error("a hora vazou para dentro do inventário: o hash do conteúdo deixaria de ser estável")
	}
	sistema, _ := inv["sistema"].(map[string]any)
	if sistema["hostname"] == "" || sistema["hostname"] == nil {
		t.Error("o inventário foi entregue sem hostname")
	}

	// --- O token foi GRAVADO ----------------------------------------------
	// Se não tivesse sido, o agente se reinscreveria a cada ciclo — e cada
	// reinscrição rotaciona o token no servidor de verdade, deixando a máquina
	// num ciclo de credencial trocada que não termina.
	idDepois, err := config.CarregarIdentidade()
	if err != nil {
		t.Fatal(err)
	}
	if idDepois.DeviceToken != "ag_do_teste" {
		t.Fatalf("o token da máquina não foi gravado: %+v", idDepois)
	}
	if idDepois.DeviceUUID != id.DeviceUUID {
		t.Fatal("o UUID da máquina mudou entre execuções: isso criaria uma duplicata no inventário")
	}

	// --- A fila ficou VAZIA depois da entrega ------------------------------
	// Item entregue e não removido é item reenviado para sempre.
	if n := s.fila.Tamanho(); n != 0 {
		t.Fatalf("a fila devia estar vazia depois da entrega, tem %d item(ns)", n)
	}

	// --- Segundo ciclo: nada mudou, nada novo é enviado --------------------
	s.UmaVez(ctx)
	_, inventarios2, batimentos2 := srv.contagens()
	if inventarios2 != 1 {
		t.Errorf("inventário igual não podia ser enviado de novo; o servidor recebeu %d", inventarios2)
	}
	if batimentos2 != 2 {
		t.Errorf("mas o batimento tinha de sair de novo: houve %d", batimentos2)
	}
}

func TestAmostraVaiParaAFilaEDepoisParaOServidor(t *testing.T) {
	/*
	 * A amostragem e o envio são separados de propósito: a máquina mede de 5 em 5
	 * minutos e entrega de 10 em 10. É o que permite ao notebook em viagem
	 * continuar medindo sem rede — e, quando ela volta, entregar o que passou em
	 * vez de só o instante.
	 *
	 * Este teste percorre os dois lados e o descarte, que é onde mora o erro mais
	 * silencioso desta parte: amostra entregue e não descartada é reenviada para
	 * sempre, e o servidor responde 200 todas as vezes porque a ingestão é
	 * idempotente. Nada falha, nada alerta, e a máquina gasta rede eternamente.
	 */
	srv := novoServidor(t)
	prepararDiretorio(t, srv.URL)
	// Relê do disco, como o serviço de verdade faz.
	lida, err := config.Carregar()
	if err != nil {
		t.Fatal(err)
	}
	id, err := config.CarregarIdentidade()
	if err != nil {
		t.Fatal(err)
	}

	s, err := Novo(lida, id, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Inscreve primeiro: sem token não há para onde mandar.
	s.UmaVez(ctx)

	for i := 0; i < 3; i++ {
		s.Amostrar(ctx)
	}
	if n := s.metricas.Tamanho(); n != 3 {
		t.Fatalf("esperava 3 amostras na fila local, tem %d", n)
	}

	s.enviarMetricas(ctx)

	srv.mu.Lock()
	lotes := len(srv.metricas)
	var enviadas int
	if lotes > 0 {
		if as, ok := srv.metricas[0]["amostras"].([]any); ok {
			enviadas = len(as)
		}
	}
	srv.mu.Unlock()

	if lotes != 1 {
		t.Fatalf("esperava UM lote, o servidor recebeu %d", lotes)
	}
	if enviadas != 3 {
		t.Fatalf("o lote levou %d amostras, esperava 3", enviadas)
	}
	if n := s.metricas.Tamanho(); n != 0 {
		t.Fatalf("a fila devia estar vazia depois da entrega, tem %d", n)
	}

	// Enviar de novo com a fila vazia não pode produzir requisição nenhuma.
	s.enviarMetricas(ctx)
	srv.mu.Lock()
	lotes = len(srv.metricas)
	srv.mu.Unlock()
	if lotes != 1 {
		t.Fatalf("fila vazia mandou um segundo lote: %d", lotes)
	}
}

func TestOBatimentoNaoSaiJuntoComAsMetricas(t *testing.T) {
	/*
	 * Mandar métrica já é dar sinal de vida — a função no banco atualiza
	 * `last_seen_at`. Um batimento depois seria uma segunda requisição dizendo o
	 * que a primeira acabou de dizer, 144 vezes por dia em cada máquina do parque.
	 */
	srv := novoServidor(t)
	cfg := prepararDiretorio(t, srv.URL)
	id, _ := config.CarregarIdentidade()
	s, err := Novo(cfg, id, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	s.UmaVez(ctx)

	_, _, batimentosAntes := srv.contagens()

	// O ciclo de envio entrega a amostra e, com a fila já vazia depois disso,
	// manda no máximo UM batimento.
	s.Amostrar(ctx)
	s.ciclarEnvio(ctx)

	_, _, batimentosDepois := srv.contagens()
	if batimentosDepois > batimentosAntes+1 {
		t.Errorf("batimentos a mais do que o necessário: %d → %d", batimentosAntes, batimentosDepois)
	}

	srv.mu.Lock()
	lotes := len(srv.metricas)
	srv.mu.Unlock()
	if lotes == 0 {
		t.Error("o ciclo de envio não entregou as métricas")
	}
}

func TestPermissaoDaIdentidadeERestrita(t *testing.T) {
	// O token da máquina é o único segredo que ela tem. 0600 não é zelo: o arquivo
	// fica num diretório que, em Linux, outros serviços conseguem listar.
	srv := novoServidor(t)
	prepararDiretorio(t, srv.URL)

	if _, err := config.CarregarIdentidade(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(config.DiretorioDeDados(), "identidade.json"))
	if err != nil {
		t.Fatal(err)
	}
	if modo := info.Mode().Perm(); modo != 0o600 {
		t.Errorf("identidade.json está %o, devia estar 600", modo)
	}
}

func TestCredencialNegadaDisparaReinscricao(t *testing.T) {
	/*
	 * O caminho do 401. A máquina pode ter sido revogada (e aí a reinscrição
	 * também é recusada, e o agente simplesmente para de ser aceito — que é o
	 * comportamento certo), ou o token pode ter sido rotacionado. Os dois chegam
	 * como 401, e o que este teste prova é que o agente TENTA se recredenciar em
	 * vez de repetir a credencial morta em silêncio.
	 */
	srv := novoServidor(t)
	cfg := prepararDiretorio(t, srv.URL)

	id, err := config.CarregarIdentidade()
	if err != nil {
		t.Fatal(err)
	}
	// Entra no ciclo já com um token — e o servidor vai recusá-lo.
	id.DeviceToken = "ag_token_revogado"
	if err := config.SalvarIdentidade(id); err != nil {
		t.Fatal(err)
	}
	srv.mu.Lock()
	srv.negarToken = true
	srv.mu.Unlock()

	s, err := Novo(cfg, id, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	s.UmaVez(context.Background())

	inscricoes, _, _ := srv.contagens()
	if inscricoes == 0 {
		t.Fatal("o 401 não disparou tentativa de reinscrição: a máquina ficaria muda sem dizer por quê")
	}
}

func TestDiagnosticoRespondeSemMandarInventario(t *testing.T) {
	// É o comando que evita uma sessão de acesso remoto na implantação, e ele não
	// pode ter efeito colateral: quem roda um diagnóstico não espera que ele
	// altere o inventário.
	srv := novoServidor(t)
	cfg := prepararDiretorio(t, srv.URL)
	id, _ := config.CarregarIdentidade()

	s, err := Novo(cfg, id, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}

	relatorio := s.Diagnostico(context.Background())

	var r map[string]any
	if err := json.Unmarshal([]byte(relatorio), &r); err != nil {
		t.Fatalf("o diagnóstico não saiu em JSON legível: %v\n%s", err, relatorio)
	}
	if r["device_uuid"] != id.DeviceUUID {
		t.Error("o diagnóstico não mostra a identidade da máquina")
	}
	if r["inscrita"] != false {
		t.Error("máquina sem token tinha de aparecer como não inscrita")
	}
	// A chave pública não está compilada no binário de teste, e o diagnóstico tem
	// de dizer isso: é a resposta para "por que a autoatualização não funciona?".
	if r["chave_de_assinatura_compilada"] != false {
		t.Error("o diagnóstico devia dizer que não há chave de assinatura compilada")
	}

	if _, inventarios, _ := srv.contagens(); inventarios != 0 {
		t.Error("o diagnóstico mandou inventário; ele não pode ter efeito colateral")
	}
}
