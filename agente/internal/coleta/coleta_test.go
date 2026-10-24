package coleta

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestChassiNormalizado(t *testing.T) {
	/*
	 * O tipo de ativo criado pelo agente sai daqui, e tipo de ativo governa
	 * relatório de garantia e de depreciação. Chutar 'desktop' num servidor de
	 * produção não dá erro nenhum — dá um relatório errado que ninguém confere.
	 */
	casos := map[string]string{
		"10":                "notebook", // SMBIOS: notebook
		"9":                 "notebook", // SMBIOS: laptop
		"notebook":          "notebook",
		"3":                 "desktop", // SMBIOS: desktop
		"Mini Tower":        "desktop",
		"23":                "server", // SMBIOS: rack mount chassis
		"server":            "server",
		"1":                 "vm", // SMBIOS: other
		"virtual machine":   "vm",
		"":                  "desconhecido",
		"alguma coisa nova": "desconhecido",
		"  NOTEBOOK  ":      "notebook", // espaço e caixa não mudam a resposta
	}
	for entrada, esperado := range casos {
		if got := chassiNormalizado(entrada); got != esperado {
			t.Errorf("chassiNormalizado(%q) = %q, esperava %q", entrada, got, esperado)
		}
	}
}

func TestLimparNormalizaEspacos(t *testing.T) {
	// Número de série com espaço sobrando é diferença de string que viraria
	// divergência na tela — "o cadastro e a máquina discordam" por causa de um
	// espaço seria o pior tipo de alarme falso: o que faz a pessoa parar de olhar.
	casos := map[string]string{
		"  5CG9274QXZ  ":     "5CG9274QXZ",
		"Dell   Inc.":        "Dell Inc.",
		"\tLatitude\n5420\t": "Latitude 5420",
		"":                   "",
	}
	for entrada, esperado := range casos {
		if got := limpar(entrada); got != esperado {
			t.Errorf("limpar(%q) = %q, esperava %q", entrada, got, esperado)
		}
	}
}

func TestColetarNuncaFalhaEDaOHostname(t *testing.T) {
	/*
	 * A coleta não devolve erro de propósito: inventário parcial é
	 * incomparavelmente melhor que inventário nenhum. O que este teste prova é
	 * que ela SEMPRE produz o campo sem o qual nada funciona.
	 *
	 * Ele roda contra a máquina de verdade, e é o único teste deste pacote que
	 * faz isso. Em contêiner, metade dos campos vem vazia — e é exatamente por
	 * isso que ele é útil: um contêiner é o ambiente mais pobre que o agente vai
	 * encontrar, e ele tem de sobreviver a ele.
	 */
	inv := Coletar(context.Background())

	if strings.TrimSpace(inv.Sistema.Hostname) == "" {
		t.Fatal("coleta sem hostname: é o único campo obrigatório")
	}
	if inv.Sistema.OS == "" {
		t.Error("coleta sem sistema operacional")
	}
	if inv.Agente == nil || inv.Agente.Plataforma == "" {
		t.Error("coleta sem identificação do agente")
	}
}

func TestOInventarioSerializadoNaoCarregaHora(t *testing.T) {
	/*
	 * É a propriedade de que depende todo o desenho de "inventário igual não vira
	 * linha nova". Um campo de hora dentro do objeto hasheado faria toda coleta
	 * parecer diferente de toda coleta, e o histórico — que existe para responder
	 * "o que mudou nesta máquina?" — viraria uma linha por dia por máquina.
	 *
	 * O teste é sobre o JSON e não sobre a struct porque é o JSON que o servidor
	 * hasheia.
	 */
	bruto, err := json.Marshal(Coletar(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	texto := string(bruto)

	for _, proibido := range []string{"coletado_em", "collected_at", "timestamp", "agora"} {
		if strings.Contains(texto, proibido) {
			t.Errorf("o inventário carrega %q — o hash do conteúdo deixaria de ser estável", proibido)
		}
	}
}

func TestCamposVaziosSomemDoJSON(t *testing.T) {
	/*
	 * `omitempty` em tudo não é economia de bytes. Um campo presente com valor
	 * vazio num dia e ausente no outro mudaria o hash sem nada ter mudado na
	 * máquina — e o jeito de isso acontecer é banal: a consulta que lê a BIOS
	 * falha por timeout numa coleta e funciona na seguinte.
	 */
	inv := Inventario{Sistema: Sistema{Hostname: "NOTE-1"}}
	bruto, err := json.Marshal(inv)
	if err != nil {
		t.Fatal(err)
	}

	texto := string(bruto)
	for _, ausente := range []string{"processador", "memoria", "discos", "bios", "software", "numero_serie"} {
		if strings.Contains(texto, ausente) {
			t.Errorf("campo vazio %q apareceu no JSON: %s", ausente, texto)
		}
	}
	if !strings.Contains(texto, `"hostname":"NOTE-1"`) {
		t.Errorf("o hostname tinha de estar lá: %s", texto)
	}
}
