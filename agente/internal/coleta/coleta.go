package coleta

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Versao é gravada no binário pelo build (`-ldflags "-X ...Versao=1.2.3"`).
var Versao = "dev"

// Coletar monta o inventário desta máquina.
//
// ## Por que nenhuma falha de coleta aborta o inventário
//
// A máquina mente, ou cala. Placa-mãe sem SMBIOS íntegro não devolve a BIOS;
// contêiner não tem chassi; Linux sem `dmidecode` não lê número de série;
// servidor com RAID por hardware não mostra disco individual. Uma coleta que
// exigisse tudo recusaria o inventário inteiro por causa de um campo.
//
// Inventário parcial é incomparavelmente melhor que inventário nenhum: "não sei
// o número de série desta máquina" é um problema; "não sei nada sobre 40 das 200
// máquinas" é o módulo não funcionando.
//
// Por isso cada coletor devolve o que conseguiu e engole o resto. O único campo
// que, faltando, invalida a coleta é o hostname — sem ele não há nem como
// mostrar a máquina numa lista.
func Coletar(ctx context.Context) Inventario {
	inv := Inventario{
		Sistema: Sistema{OS: runtime.GOOS},
		Agente:  &Agente{Versao: Versao, Plataforma: runtime.GOOS + "/" + runtime.GOARCH},
	}

	if nome, err := os.Hostname(); err == nil {
		inv.Sistema.Hostname = strings.TrimSpace(nome)
	}

	coletarPlataforma(ctx, &inv)

	// Normaliza o que os coletores possam ter deixado sujo. Espaço sobrando num
	// número de série é diferença de string que viraria divergência na tela.
	inv.Sistema.Fabricante = limpar(inv.Sistema.Fabricante)
	inv.Sistema.Modelo = limpar(inv.Sistema.Modelo)
	inv.Sistema.NumeroSerie = limpar(inv.Sistema.NumeroSerie)
	inv.Sistema.ServiceTag = limpar(inv.Sistema.ServiceTag)

	return inv
}

func limpar(s string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
}

// rodar executa um comando com prazo e devolve a saída padrão.
//
// O prazo não é zelo: `wmic`, `system_profiler` e `dpkg-query` travam em máquina
// com disco ruim ou serviço de WMI corrompido, e um agente travado é um agente
// mudo — que é o estado mais difícil de diagnosticar, porque não produz erro
// nenhum em lugar nenhum.
func rodar(ctx context.Context, prazo time.Duration, nome string, args ...string) (string, error) {
	c, cancelar := context.WithTimeout(ctx, prazo)
	defer cancelar()

	cmd := exec.CommandContext(c, nome, args...)
	// Sem herdar o ambiente: um `PATH` ou um `LD_PRELOAD` plantado é o caminho
	// clássico para fazer um serviço com privilégio executar outra coisa.
	cmd.Env = []string{"LC_ALL=C", "LANG=C"}
	saida, err := cmd.Output()
	return string(saida), err
}

// chassiNormalizado traduz o que cada sistema chama de gabinete para as quatro
// palavras que o servidor conhece.
//
// `desconhecido` é devolvido em vez de um chute. Chutar 'desktop' num servidor
// de produção faria o inventário criar um ativo do tipo errado, e tipo de ativo
// é o que governa relatório de garantia e de depreciação.
func chassiNormalizado(bruto string) string {
	switch strings.ToLower(strings.TrimSpace(bruto)) {
	case "8", "9", "10", "11", "12", "14", "18", "21", "31", "32", "notebook", "laptop", "portable", "sub notebook":
		return "notebook"
	case "3", "4", "5", "6", "7", "13", "15", "16", "desktop", "tower", "mini tower", "all in one":
		return "desktop"
	case "17", "23", "25", "28", "server", "rack mount chassis", "blade":
		return "server"
	case "1", "2", "vm", "virtual machine", "other":
		return "vm"
	default:
		return "desconhecido"
	}
}
