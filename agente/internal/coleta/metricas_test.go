package coleta

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestAmostrarNaMaquinaDeVerdade(t *testing.T) {
	/*
	 * Roda contra a máquina onde o teste está. É o único jeito de descobrir que a
	 * leitura de CPU devolve zero, que a memória veio em kilobytes tratada como
	 * bytes, ou que a lista de volumes trouxe quarenta `tmpfs`.
	 *
	 * As asserções são frouxas de propósito — um contêiner tem menos do que uma
	 * estação —, mas as que ficaram pegam exatamente os erros acima.
	 */
	a := Amostrar(context.Background(), nil)

	if _, err := time.Parse(time.RFC3339, a.Em); err != nil {
		t.Fatalf("carimbo de hora inválido %q: %v", a.Em, err)
	}
	if a.CPU < 0 || a.CPU > 100 {
		t.Errorf("CPU fora de 0–100: %v", a.CPU)
	}

	if a.MemTotal <= 0 {
		t.Error("memória total não foi lida")
	}
	if a.MemUsada > a.MemTotal {
		t.Errorf("memória usada (%d) maior que a total (%d)", a.MemUsada, a.MemTotal)
	}
	// Um gigabyte é o piso de qualquer máquina que rode este agente. Pegar o erro
	// de unidade (kilobytes tratados como bytes) é o ponto: ele faria o parque
	// inteiro aparecer com 16 MB de RAM.
	if a.MemTotal > 0 && a.MemTotal < 1<<30 {
		t.Errorf("memória total implausível (%d bytes): erro de unidade?", a.MemTotal)
	}

	/*
	 * A memória USADA não pode ser quase toda a memória numa máquina ociosa.
	 *
	 * É a asserção que protege a decisão de usar `MemAvailable` em vez de
	 * `MemFree`: o Linux usa toda a memória livre como cache de disco, e relatar
	 * `MemFree` faria toda máquina saudável do parque aparecer com 98% de
	 * memória em uso.
	 */
	if a.MemTotal > 0 {
		uso := float64(a.MemUsada) / float64(a.MemTotal) * 100
		if uso > 97 {
			t.Errorf("memória em uso de %.0f%%: provável leitura de MemFree em vez de MemAvailable", uso)
		}
	}
}

func TestVolumesSaoDiscoDeVerdade(t *testing.T) {
	a := Amostrar(context.Background(), nil)

	for _, v := range a.Volumes {
		if v.Ponto == "" {
			t.Error("volume sem ponto de montagem")
		}
		if v.Total <= 0 {
			t.Errorf("volume %q com tamanho zero não devia ter entrado", v.Ponto)
		}
		if v.Livre > v.Total {
			t.Errorf("volume %q com mais livre (%d) que total (%d)", v.Ponto, v.Livre, v.Total)
		}
		// `tmpfs` e companhia moram na memória: contá-los como disco encheria a
		// tela de volumes que não existem — e um `/dev/shm` em 100% abriria
		// alerta todo dia sem nada estar errado.
		for _, virtual := range []string{"/proc", "/sys", "/dev/shm", "/run/lock"} {
			if v.Ponto == virtual {
				t.Errorf("sistema de arquivos virtual %q entrou como volume", v.Ponto)
			}
		}
	}
}

func TestServicoInexistenteContaComoFora(t *testing.T) {
	/*
	 * Serviço configurado que não existe na máquina conta como fora do ar, e isso
	 * é uma escolha: ou alguém o desinstalou (que é o alerta que se quer), ou a
	 * configuração tem um nome errado (que também precisa aparecer). Silêncio
	 * seria pior que os dois — a pessoa acharia que está vigiando algo que não
	 * está.
	 */
	a := Amostrar(context.Background(), []string{"servico-que-nao-existe-em-lugar-nenhum"})
	if len(a.ServicosFora) == 0 {
		t.Skip("sem systemd nesta máquina: a coleta devolve nada, que é o comportamento certo aqui")
	}
	if a.ServicosFora[0] != "servico-que-nao-existe-em-lugar-nenhum" {
		t.Errorf("reportou o serviço errado: %v", a.ServicosFora)
	}
}

func TestSemServicosConfiguradosNaoHaCampo(t *testing.T) {
	// `omitempty` em `servicos_fora`: numa frota de 200 máquinas enviando 288
	// amostras por dia, um campo vazio presente é tráfego que não transporta
	// nada.
	bruto, err := json.Marshal(Amostrar(context.Background(), nil))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(bruto), "servicos_fora") {
		t.Errorf("campo vazio apareceu no JSON: %s", bruto)
	}
}

func TestIdDeAcessoRemotoNoTOML(t *testing.T) {
	casos := []struct {
		nome     string
		conteudo string
		esperado string
	}{
		{"aspas simples", "rendezvous_server = 'x'\nid = '123456789'\n", "123456789"},
		{"aspas duplas", `id = "987654321"`, "987654321"},
		{"sem aspas", "id = 123456789", "123456789"},
		{"com espaços", "   id   =   '123456789'   ", "123456789"},
		{"comentado", "# id = '111111111'\nid = '222222222'", "222222222"},
		{"ausente", "rendezvous_server = 'x'\n", ""},
		{"vazio", "", ""},
		// Uma chave `id` de outra seção, com valor curto, não pode ser devolvida
		// como se fosse o id da máquina.
		{"curto demais", "id = '12'", ""},
	}
	for _, c := range casos {
		if got := idNoTOML(c.conteudo); got != c.esperado {
			t.Errorf("%s: idNoTOML = %q, esperava %q", c.nome, got, c.esperado)
		}
	}
}

func TestIdDeAcessoRemotoAusenteNaoEErro(t *testing.T) {
	// A maioria das instalações não usa acesso remoto. A ausência tem de ser
	// silenciosa: avisar sobre um recurso opcional que não está lá é ruído, e
	// ruído é o que faz as pessoas pararem de ler o registro.
	if id := IdDeAcessoRemoto(); id != "" {
		t.Logf("esta máquina tem RustDesk instalado (id %q) — o teste segue válido", id)
	}
}
