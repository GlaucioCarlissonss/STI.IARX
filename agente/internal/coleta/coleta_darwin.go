//go:build darwin

package coleta

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

/*
A coleta no macOS usa `system_profiler -json` e `sysctl`.

`system_profiler` é a ferramenta que a própria Apple documenta para isto, e o
`-json` existe desde o Catalina — então não há parse de texto para quebrar na
próxima versão do sistema. `sysctl` cobre o que ele não dá (memória total e
tempo ligado) e é instantâneo.

Como no Windows, **este arquivo não foi executado em macOS**. Ele compila, e as
chaves usadas são as que o `-json` documenta, mas a primeira execução em máquina
real pode exigir ajuste. O Mac também é a plataforma de menor peso neste parque:
o agente existe antes de tudo para o Windows corporativo.
*/

func coletarPlataforma(ctx context.Context, inv *Inventario) {
	type hardware struct {
		SPHardwareDataType []struct {
			Modelo  string `json:"machine_model"`
			Nome    string `json:"machine_name"`
			Serial  string `json:"serial_number"`
			Chip    string `json:"chip_type"`
			CPU     string `json:"cpu_type"`
			Nucleos any    `json:"number_processors"`
			Memoria string `json:"physical_memory"`
			BootROM string `json:"boot_rom_version"`
		} `json:"SPHardwareDataType"`
	}
	var hw hardware
	if saida, err := rodar(ctx, 60*time.Second, "system_profiler", "-json", "SPHardwareDataType"); err == nil {
		_ = json.Unmarshal([]byte(saida), &hw)
	}
	if len(hw.SPHardwareDataType) > 0 {
		h := hw.SPHardwareDataType[0]
		inv.Sistema.Fabricante = "Apple Inc."
		inv.Sistema.Modelo = primeiroNaoVazio(h.Nome, h.Modelo)
		inv.Sistema.NumeroSerie = h.Serial
		// Todo Mac com `system_profiler` é UEFI-equivalente; a Apple não usa BIOS
		// legado desde 2006, então declarar `uefi` aqui é fato, não chute.
		inv.BIOS = &BIOS{Fabricante: "Apple Inc.", Versao: h.BootROM, Modo: "uefi"}
		inv.Processador = &Processador{
			Modelo:  primeiroNaoVazio(h.Chip, h.CPU),
			Nucleos: nucleosDoTexto(h.Nucleos),
			Threads: int(sysctlInt(ctx, "hw.ncpu")),
		}
		// Portátil ou de mesa, pelo nome do modelo. É o que a Apple dá: não há
		// campo de chassi, e "MacBook" no nome é informação suficiente.
		if strings.Contains(strings.ToLower(h.Nome+h.Modelo), "book") {
			inv.Sistema.Chassi = "notebook"
		} else {
			inv.Sistema.Chassi = "desktop"
		}
	}

	if total := sysctlInt(ctx, "hw.memsize"); total > 0 {
		inv.Memoria = &Memoria{TotalBytes: total}
	}

	if saida, err := rodar(ctx, 15*time.Second, "sw_vers", "-productVersion"); err == nil {
		inv.Sistema.OSVersion = "macOS " + strings.TrimSpace(saida)
	}
	if saida, err := rodar(ctx, 15*time.Second, "sw_vers", "-buildVersion"); err == nil {
		inv.Sistema.OSBuild = strings.TrimSpace(saida)
	}
	if saida, err := rodar(ctx, 15*time.Second, "stat", "-f", "%Su", "/dev/console"); err == nil {
		// O dono de `/dev/console` é quem está na frente da máquina. É o caminho
		// que a própria Apple usa nos scripts de gerenciamento, e não depende de
		// serviço nenhum estar no ar.
		inv.Sistema.UsuarioLogado = strings.TrimSpace(saida)
	}

	inv.Discos = discosDarwin(ctx)
	inv.Software = aplicativos(ctx)
}

func discosDarwin(ctx context.Context) []Disco {
	type armazenamento struct {
		SPNVMeDataType []struct {
			Itens []struct {
				Nome    string `json:"_name"`
				Tamanho any    `json:"size_in_bytes"`
			} `json:"_items"`
		} `json:"SPNVMeDataType"`
	}
	var a armazenamento
	saida, err := rodar(ctx, 60*time.Second, "system_profiler", "-json", "SPNVMeDataType")
	if err != nil {
		return nil
	}
	_ = json.Unmarshal([]byte(saida), &a)

	var out []Disco
	for _, c := range a.SPNVMeDataType {
		for _, i := range c.Itens {
			d := Disco{Modelo: i.Nome, TamanhoBytes: paraInt64(i.Tamanho), Tipo: "nvme", Saude: "desconhecido"}
			if d.TamanhoBytes > 0 {
				out = append(out, d)
			}
		}
	}
	return out
}

// aplicativos lista o que está em /Applications.
//
// `system_profiler SPApplicationsDataType` é a fonte completa e demora minutos
// — ele varre o disco inteiro procurando bundle. Numa coleta diária isso é
// tempo de CPU que o usuário sente. A lista de `/Applications` cobre o que
// interessa a um inventário corporativo (o que foi instalado de propósito) e sai
// em segundos.
func aplicativos(ctx context.Context) []Programa {
	const consulta = `for app in /Applications/*.app; do
  nome=$(basename "$app" .app)
  versao=$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)
  echo "$nome	$versao"
done`
	saida, err := rodar(ctx, 90*time.Second, "/bin/sh", "-c", consulta)
	if err != nil {
		return nil
	}

	var out []Programa
	for _, linha := range strings.Split(saida, "\n") {
		nome, versao, _ := strings.Cut(linha, "\t")
		nome = strings.TrimSpace(nome)
		if nome == "" || strings.Contains(nome, "*") {
			continue
		}
		out = append(out, Programa{Nome: nome, Versao: strings.TrimSpace(versao)})
	}
	return out
}

func sysctlInt(ctx context.Context, chave string) int64 {
	saida, err := rodar(ctx, 10*time.Second, "sysctl", "-n", chave)
	if err != nil {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSpace(saida), 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func nucleosDoTexto(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case string:
		// Vem como "8" ou como "proc 8:4:4" nos Apple Silicon.
		campos := strings.Fields(t)
		for _, c := range campos {
			if n, err := strconv.Atoi(strings.Split(c, ":")[0]); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

func primeiroNaoVazio(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func paraInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}

func tempoLigado() int64 {
	saida, err := rodar(context.Background(), 10*time.Second, "sysctl", "-n", "kern.boottime")
	if err != nil {
		return 0
	}
	// `{ sec = 1700000000, usec = 0 } Tue Nov ...`
	_, resto, achou := strings.Cut(saida, "sec = ")
	if !achou {
		return 0
	}
	segundos, _, _ := strings.Cut(resto, ",")
	n, err := strconv.ParseInt(strings.TrimSpace(segundos), 10, 64)
	if err != nil || n <= 0 {
		return 0
	}
	return time.Now().Unix() - n
}
