package fila

import (
	"encoding/json"
	"os"
	"testing"
)

/*
A fila de métricas erra de dois jeitos caros: perdendo amostra que ainda não foi
entregue (e o gráfico fica com buraco que ninguém explica), ou não descartando a
que já foi (e o mesmo lote é reenviado para sempre, a cada dez minutos, em cada
máquina do parque).

O segundo é pior e mais silencioso: o servidor responde 200 todas as vezes,
porque a ingestão é idempotente — então nada falha, nada alerta, e a máquina
gasta rede eternamente mandando o que já mandou.
*/

func novaFilaDeMetricas(t *testing.T) *FilaDeMetricas {
	t.Helper()
	f, err := AbrirMetricas(t.TempDir())
	if err != nil {
		t.Fatalf("abrindo: %v", err)
	}
	return f
}

type amostraFalsa struct {
	Em  string  `json:"em"`
	CPU float64 `json:"cpu"`
}

func TestFilaVaziaNaoEErro(t *testing.T) {
	// O arquivo nem existe ainda: é o estado de toda máquina recém-instalada.
	f := novaFilaDeMetricas(t)
	amostras, err := f.Ler(10)
	if err != nil {
		t.Fatalf("fila inexistente devolveu erro: %v", err)
	}
	if len(amostras) != 0 {
		t.Fatalf("esperava vazio, veio %d", len(amostras))
	}
	if f.Tamanho() != 0 {
		t.Fatal("tamanho de fila inexistente devia ser 0")
	}
	if err := f.Descartar(5); err != nil {
		t.Fatalf("descartar de fila vazia devolveu erro: %v", err)
	}
}

func TestAnexarELerEmOrdem(t *testing.T) {
	f := novaFilaDeMetricas(t)
	for i := 0; i < 5; i++ {
		if err := f.Anexar(amostraFalsa{Em: "2026-01-0" + string(rune('1'+i)), CPU: float64(i)}); err != nil {
			t.Fatal(err)
		}
	}

	amostras, err := f.Ler(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(amostras) != 5 {
		t.Fatalf("esperava 5, veio %d", len(amostras))
	}

	// A ordem é a do tempo, e importa: o servidor usa (device, collected_at)
	// como chave, mas o gráfico lê a sequência.
	for i, bruto := range amostras {
		var a amostraFalsa
		if err := json.Unmarshal(bruto, &a); err != nil {
			t.Fatal(err)
		}
		if a.CPU != float64(i) {
			t.Fatalf("amostra %d fora de ordem: %+v", i, a)
		}
	}
}

func TestLerRespeitaOLimiteDoLote(t *testing.T) {
	// Sem o limite, uma fila de duas semanas viraria uma requisição que o
	// servidor corta no meio — deixando metade entregue e nenhum registro de onde.
	f := novaFilaDeMetricas(t)
	for i := 0; i < 20; i++ {
		_ = f.Anexar(amostraFalsa{CPU: float64(i)})
	}
	amostras, _ := f.Ler(7)
	if len(amostras) != 7 {
		t.Fatalf("esperava 7, veio %d", len(amostras))
	}
}

func TestDescartarRemoveSoOQueFoiEntregue(t *testing.T) {
	f := novaFilaDeMetricas(t)
	for i := 0; i < 5; i++ {
		_ = f.Anexar(amostraFalsa{CPU: float64(i)})
	}

	if err := f.Descartar(3); err != nil {
		t.Fatal(err)
	}
	if n := f.Tamanho(); n != 2 {
		t.Fatalf("esperava 2 restantes, veio %d", n)
	}

	restantes, _ := f.Ler(10)
	var a amostraFalsa
	_ = json.Unmarshal(restantes[0], &a)
	if a.CPU != 3 {
		t.Fatalf("o descarte tirou as erradas: sobrou CPU=%v, esperava 3", a.CPU)
	}
}

func TestDescartarTudoRemoveOArquivo(t *testing.T) {
	// Deixar um arquivo vazio para trás funcionaria, mas um arquivo de zero bytes
	// num diretório de estado é a coisa que faz alguém abrir e se perguntar se
	// está quebrado.
	f := novaFilaDeMetricas(t)
	_ = f.Anexar(amostraFalsa{CPU: 1})
	if err := f.Descartar(1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(f.caminho); !os.IsNotExist(err) {
		t.Fatal("fila esvaziada devia ter removido o arquivo")
	}
}

func TestPodarCortaPeloCOMECO(t *testing.T) {
	/*
	 * O oposto da fila de inventário, e de propósito.
	 *
	 * No inventário, o item mais RECENTE é o estado real da máquina e nunca pode
	 * ser descartado. Na métrica, a amostra velha já não ajuda ninguém a decidir
	 * nada — o que não pode sumir é o recente.
	 */
	f := novaFilaDeMetricas(t)
	f.teto = 5
	for i := 0; i < 12; i++ {
		_ = f.Anexar(amostraFalsa{CPU: float64(i)})
		if err := f.Podar(); err != nil {
			t.Fatal(err)
		}
	}

	amostras, _ := f.Ler(100)
	if len(amostras) != 5 {
		t.Fatalf("o teto é 5, a fila tem %d", len(amostras))
	}

	var primeira, ultima amostraFalsa
	_ = json.Unmarshal(amostras[0], &primeira)
	_ = json.Unmarshal(amostras[len(amostras)-1], &ultima)
	if ultima.CPU != 11 {
		t.Fatalf("a amostra mais recente foi descartada: a última é CPU=%v", ultima.CPU)
	}
	if primeira.CPU != 7 {
		t.Fatalf("o corte não foi pelo começo: a primeira é CPU=%v, esperava 7", primeira.CPU)
	}
}

func TestLinhaCorrompidaNaoDerrubaOResto(t *testing.T) {
	/*
	 * Uma queda de energia no meio de um `write` deixa uma linha parcial no fim do
	 * arquivo. Ela não pode impedir as anteriores de serem entregues — e, se
	 * impedisse, a máquina pararia de mandar métrica para sempre a partir da
	 * primeira queda de energia, sem nada no registro dizendo por quê.
	 */
	f := novaFilaDeMetricas(t)
	_ = f.Anexar(amostraFalsa{CPU: 1})
	_ = f.Anexar(amostraFalsa{CPU: 2})

	arq, err := os.OpenFile(f.caminho, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = arq.WriteString("{\"em\":\"2026-01-01\",\"cp\n")
	_ = arq.Close()
	_ = f.Anexar(amostraFalsa{CPU: 3})

	amostras, err := f.Ler(10)
	if err != nil {
		t.Fatalf("linha corrompida derrubou a leitura: %v", err)
	}
	if len(amostras) != 3 {
		t.Fatalf("esperava 3 amostras legíveis, veio %d", len(amostras))
	}

	// E o descarte conta só as válidas, senão descartaria de menos para sempre.
	if err := f.Descartar(3); err != nil {
		t.Fatal(err)
	}
	validas, _ := f.Ler(10)
	if len(validas) != 0 {
		t.Fatalf("depois de descartar as 3 válidas sobrou %d", len(validas))
	}
}

func TestQuebraDeLinhaNoConteudoNaoParteOArquivo(t *testing.T) {
	/*
	 * O formato de uma linha por amostra depende de nenhuma amostra conter uma
	 * quebra de linha crua. Quem garante isso é `json.Marshal` — e é esse
	 * invariante, e não uma conferência defensiva, que este teste fixa.
	 *
	 * O caso não é hipotético: o nome de um serviço crítico vem do arquivo de
	 * configuração, que um administrador edita à mão.
	 */
	f := novaFilaDeMetricas(t)
	type comTexto struct {
		Nome string `json:"nome"`
	}
	if err := f.Anexar(comTexto{Nome: "servi\nco\tquebrado"}); err != nil {
		t.Fatal(err)
	}
	if err := f.Anexar(comTexto{Nome: "seguinte"}); err != nil {
		t.Fatal(err)
	}

	amostras, err := f.Ler(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(amostras) != 2 {
		t.Fatalf("a quebra de linha partiu o arquivo: %d amostras em vez de 2", len(amostras))
	}

	var a comTexto
	if err := json.Unmarshal(amostras[0], &a); err != nil {
		t.Fatal(err)
	}
	if a.Nome != "servi\nco\tquebrado" {
		t.Fatalf("o conteúdo não voltou inteiro: %q", a.Nome)
	}
}
