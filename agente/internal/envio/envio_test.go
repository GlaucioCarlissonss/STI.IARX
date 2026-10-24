package envio

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
O que estes testes cobrem é a conversa com o servidor — e, acima de tudo, o
tratamento do 401.

O 401 é o único erro aqui que exige uma reação diferente de "tente de novo
depois". Tratá-lo como erro de rede faria o agente repetir uma credencial
recusada a cada dez minutos, para sempre, sem reclamar em lugar nenhum — que é
o defeito mais caro que este pacote pode ter, porque a máquina fica muda e o
registro não diz por quê.
*/

func servidorFalso(t *testing.T, h http.HandlerFunc) *Cliente {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	return Novo(s.URL, "1.2.3")
}

func TestInscricaoDevolveOTokenDaMaquina(t *testing.T) {
	var recebido map[string]any
	c := servidorFalso(t, func(w http.ResponseWriter, r *http.Request) {
		bruto, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(bruto, &recebido)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"device_id":"d1","device_token":"ag_abc","tenant_id":"t1"}`))
	})

	r, err := c.Inscrever(context.Background(), "inv_lote", map[string]string{
		"device_uuid": "11111111-1111-4111-8111-111111111111",
		"hostname":    "NOTE-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.DeviceToken != "ag_abc" || r.DeviceID != "d1" {
		t.Fatalf("resposta errada: %+v", r)
	}
	if recebido["enrollment_token"] != "inv_lote" {
		t.Errorf("o token do lote não chegou: %+v", recebido)
	}
}

func TestInscricaoSemTokenNaRespostaEErro(t *testing.T) {
	// 200 com corpo vazio é a forma mais traiçoeira de falha: o agente acharia que
	// se inscreveu, gravaria uma identidade sem token e nunca mais mandaria nada.
	c := servidorFalso(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"device_id":"d1"}`))
	})

	if _, err := c.Inscrever(context.Background(), "inv_lote", nil); err == nil {
		t.Fatal("aceitou uma inscrição sem token")
	}
}

func TestO401ViraErrCredencialMorta(t *testing.T) {
	for _, caminho := range []string{"inventario", "batimento"} {
		t.Run(caminho, func(t *testing.T) {
			c := servidorFalso(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"erro":"Token da máquina não é válido."}`))
			})

			var err error
			if caminho == "inventario" {
				_, err = c.EnviarInventario(context.Background(), "ag_velho", []byte(`{}`))
			} else {
				err = c.Batimento(context.Background(), "ag_velho")
			}

			if !errors.Is(err, ErrCredencialMorta) {
				t.Fatalf("esperava ErrCredencialMorta, veio: %v", err)
			}
		})
	}
}

func TestOTokenVaiNoCabecalhoEAVersaoTambem(t *testing.T) {
	var auth, versao string
	c := servidorFalso(t, func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		versao = r.Header.Get("X-Agent-Version")
		_, _ = w.Write([]byte(`{"status":"unchanged"}`))
	})

	if _, err := c.EnviarInventario(context.Background(), "ag_token", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer ag_token" {
		t.Errorf("cabeçalho de autorização errado: %q", auth)
	}
	// A versão no cabeçalho é o que permite ao servidor registrar quem está
	// desatualizado sem o agente precisar mandar um corpo para isso.
	if versao != "1.2.3" {
		t.Errorf("versão do agente não foi anunciada: %q", versao)
	}
}

func TestErroDeServidorNaoViraCredencialMorta(t *testing.T) {
	/*
	 * A distinção que importa: 500 é "tente depois", 401 é "pare de tentar com
	 * esta credencial". Confundir os dois nos dois sentidos é ruim — um faz a
	 * máquina desistir por causa de uma queda momentânea, o outro faz ela insistir
	 * para sempre com um token revogado.
	 */
	c := servidorFalso(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"erro":"Não foi possível registrar o inventário."}`))
	})

	_, err := c.EnviarInventario(context.Background(), "ag_token", []byte(`{}`))
	if err == nil {
		t.Fatal("500 tem de ser erro")
	}
	if errors.Is(err, ErrCredencialMorta) {
		t.Fatal("500 virou ErrCredencialMorta: a máquina desistiria por uma queda momentânea")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("o erro devia dizer o código: %v", err)
	}
}

func TestBatimentoNaoMandaCorpo(t *testing.T) {
	// É a razão de a rota existir separada: 200 máquinas × 144 contatos por dia ×
	// meio megabyte de inventário seriam 14 GB por dia para dizer "estou viva".
	var tamanho int64 = -1
	c := servidorFalso(t, func(w http.ResponseWriter, r *http.Request) {
		bruto, _ := io.ReadAll(r.Body)
		tamanho = int64(len(bruto))
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	if err := c.Batimento(context.Background(), "ag_token"); err != nil {
		t.Fatal(err)
	}
	if tamanho != 0 {
		t.Fatalf("o batimento mandou %d bytes de corpo; tem de mandar zero", tamanho)
	}
}

func TestVersaoPublicadaTrata204ComoNadaAFazer(t *testing.T) {
	// 204 é o estado NORMAL de quem não configurou a autoatualização, e precisa
	// chegar como "não há nada" e não como erro — senão o registro do agente
	// encheria de falha em toda máquina que não usa o recurso.
	c := servidorFalso(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	p, err := c.VersaoPublicada(context.Background())
	if err != nil {
		t.Fatalf("204 não é erro: %v", err)
	}
	if p != nil {
		t.Fatalf("204 tinha de devolver nil, veio %+v", p)
	}
}

func TestVersaoPublicadaLeAPublicacao(t *testing.T) {
	c := servidorFalso(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"versao":"2.0.0","url":"https://x/a","sha256":"ab","assinatura":"cd","checar_a_cada_min":720}`))
	})

	p, err := c.VersaoPublicada(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if p == nil || p.Versao != "2.0.0" || p.Assinatura != "cd" {
		t.Fatalf("publicação lida errado: %+v", p)
	}
}

func TestRespostaEnormeNaoEstouraAMemoria(t *testing.T) {
	/*
	 * O agente não controla o que está do outro lado. Um proxy mal configurado
	 * devolvendo uma página de erro de 50 MB não pode estourar a memória de um
	 * serviço que roda na máquina do usuário — e o limite tem de valer inclusive
	 * no caminho de sucesso, que é onde ninguém pensa em pôr limite.
	 */
	c := servidorFalso(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"stored","lixo":"`))
		for i := 0; i < 3_000; i++ {
			_, _ = w.Write([]byte(strings.Repeat("x", 1024)))
		}
		_, _ = w.Write([]byte(`"}`))
	})

	// Truncada, a resposta não é JSON válido — e o erro de decodificação é o
	// comportamento certo: melhor recusar que consumir 3 MB de lixo.
	if _, err := c.EnviarInventario(context.Background(), "ag_token", []byte(`{}`)); err == nil {
		t.Fatal("resposta truncada tinha de falhar na decodificação")
	}
}
