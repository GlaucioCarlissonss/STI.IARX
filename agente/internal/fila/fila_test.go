package fila

import (
	"os"
	"testing"
)

/*
A fila é onde o dado do notebook em viagem fica guardado. Um erro aqui não dá
erro: dá inventário que sumiu, ou inventário entregue fora de ordem — e fora de
ordem significa que o histórico de "o que mudou nesta máquina" conta a história
ao contrário.
*/

func novaFila(t *testing.T) *Fila {
	t.Helper()
	f, err := Abrir(t.TempDir())
	if err != nil {
		t.Fatalf("abrindo a fila: %v", err)
	}
	return f
}

type envelopeFalso struct {
	ColetadoEm string `json:"coletado_em"`
	Inventario any    `json:"inventario"`
}

func TestHashIgnoraAHoraDaColeta(t *testing.T) {
	// É a propriedade que faz a fila não encher com trinta cópias idênticas de um
	// notebook que passou um mês fora do ar.
	inv := map[string]any{"sistema": map[string]any{"hostname": "NOTE-1"}}

	a, err := HashDoConteudo(inv)
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashDoConteudo(inv)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("o mesmo conteúdo deu hashes diferentes: %s vs %s", a, b)
	}

	outro, _ := HashDoConteudo(map[string]any{"sistema": map[string]any{"hostname": "NOTE-2"}})
	if a == outro {
		t.Fatal("conteúdos diferentes deram o mesmo hash")
	}
}

func TestColetaIgualNaoEnfileiraDuasVezes(t *testing.T) {
	f := novaFila(t)
	inv := map[string]any{"hostname": "NOTE-1"}
	hash, _ := HashDoConteudo(inv)

	novo, err := f.Enfileirar(envelopeFalso{"2026-01-01T00:00:00Z", inv}, hash)
	if err != nil {
		t.Fatal(err)
	}
	if !novo {
		t.Fatal("a primeira coleta tem de ser enfileirada")
	}

	// Mesma coleta, hora diferente: é o que acontece todo dia numa máquina estável.
	novo, err = f.Enfileirar(envelopeFalso{"2026-01-02T00:00:00Z", inv}, hash)
	if err != nil {
		t.Fatal(err)
	}
	if novo {
		t.Fatal("coleta com o mesmo conteúdo não pode virar um segundo item")
	}
	if n := f.Tamanho(); n != 1 {
		t.Fatalf("a fila devia ter 1 item, tem %d", n)
	}
}

func TestColetaQueMudouEnfileiraEPreservaAOrdem(t *testing.T) {
	f := novaFila(t)

	for i, nome := range []string{"A", "B", "C"} {
		inv := map[string]any{"hostname": nome}
		hash, _ := HashDoConteudo(inv)
		novo, err := f.Enfileirar(envelopeFalso{"2026-01-0" + string(rune('1'+i)) + "T00:00:00Z", inv}, hash)
		if err != nil {
			t.Fatal(err)
		}
		if !novo {
			t.Fatalf("a coleta %s mudou e tinha de ser enfileirada", nome)
		}
	}

	pendentes := f.Pendentes()
	if len(pendentes) != 3 {
		t.Fatalf("esperava 3 itens, veio %d", len(pendentes))
	}

	/*
	 * A ordem é a do nome, e o nome começa com a hora em formato ordenável. Ela
	 * importa: o histórico de inventário é lido como linha do tempo, e entregar o
	 * item 3 antes do 2 faria "memória caiu de 16 para 8" virar "subiu de 8 para
	 * 16" na tela.
	 */
	for i := 1; i < len(pendentes); i++ {
		if pendentes[i-1] >= pendentes[i] {
			t.Fatalf("a fila não saiu em ordem: %v", pendentes)
		}
	}

	bruto, err := f.Ler(pendentes[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(bruto) == 0 {
		t.Fatal("o primeiro item veio vazio")
	}
}

func TestRemoverTiraDaFila(t *testing.T) {
	f := novaFila(t)
	inv := map[string]any{"hostname": "X"}
	hash, _ := HashDoConteudo(inv)
	if _, err := f.Enfileirar(envelopeFalso{"2026-01-01T00:00:00Z", inv}, hash); err != nil {
		t.Fatal(err)
	}

	pendentes := f.Pendentes()
	if err := f.Remover(pendentes[0]); err != nil {
		t.Fatal(err)
	}
	if n := f.Tamanho(); n != 0 {
		t.Fatalf("depois de remover a fila devia estar vazia, tem %d", n)
	}
}

func TestOTetoDescartaOMaisAntigoENaoOMaisRecente(t *testing.T) {
	/*
	 * Esta é a asserção que protege a decisão explicada em `podar()`: o inventário
	 * MAIS RECENTE é o estado real da máquina, e é o que o sistema precisa ter. O
	 * histórico intermediário é desejável e perdível. Descartar pelo lado errado
	 * deixaria o inventário com um retrato de um ano atrás.
	 */
	f := novaFila(t)
	f.teto = 3

	var primeiro, ultimo string
	for i := 0; i < 6; i++ {
		inv := map[string]any{"n": i}
		hash, _ := HashDoConteudo(inv)
		if _, err := f.Enfileirar(envelopeFalso{"2026-01-01T00:00:00Z", inv}, hash); err != nil {
			t.Fatal(err)
		}
		pendentes := f.Pendentes()
		if i == 0 {
			primeiro = pendentes[0]
		}
		ultimo = pendentes[len(pendentes)-1]
	}

	pendentes := f.Pendentes()
	if len(pendentes) != 3 {
		t.Fatalf("o teto é 3, a fila tem %d", len(pendentes))
	}
	for _, n := range pendentes {
		if n == primeiro {
			t.Fatal("o item mais antigo tinha de ter sido descartado")
		}
	}
	if pendentes[len(pendentes)-1] != ultimo {
		t.Fatal("o item mais recente NUNCA pode ser descartado: ele é o estado real da máquina")
	}
}

func TestArquivoEmGravacaoNaoApareceComoPendente(t *testing.T) {
	// O ponto na frente marca gravação em curso. Se um item aparecesse antes do
	// rename, o envio leria um JSON pela metade e o servidor recusaria uma coleta
	// que estava íntegra no disco um milissegundo depois.
	f := novaFila(t)
	if err := os.WriteFile(f.dir+"/.20260101T000000.000-abcd1234.json", []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if n := f.Tamanho(); n != 0 {
		t.Fatalf("arquivo em gravação não é item da fila, mas contou %d", n)
	}
}
