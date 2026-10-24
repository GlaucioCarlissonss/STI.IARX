//go:build darwin

package coleta

import (
	"context"
	"strconv"
	"strings"
	"syscall"
	"time"
)

/*
As métricas no macOS.

CPU sai do `top` em modo de log, que é a ferramenta que a própria Apple expõe e
que não exige privilégio. Memória sai do `vm_stat`, e o cálculo merece a nota
abaixo. Volumes saem do `statfs`, igual ao Linux.

Como o inventário deste sistema, este arquivo não foi executado em macOS.
*/

func cpuPercentual(ctx context.Context) float64 {
	// `-l 2` porque a primeira amostra do `top` é o acumulado desde o boot, não
	// o instante — o mesmo motivo de o Linux ler /proc/stat duas vezes e de o
	// Windows pedir duas amostras ao contador.
	saida, err := rodar(ctx, 30*time.Second, "top", "-l", "2", "-n", "0", "-s", "1")
	if err != nil {
		return 0
	}

	// A última linha "CPU usage: 4.76% user, 9.52% sys, 85.71% idle".
	var ocioso float64 = -1
	for _, linha := range strings.Split(saida, "\n") {
		if !strings.HasPrefix(linha, "CPU usage:") {
			continue
		}
		for _, parte := range strings.Split(linha, ",") {
			parte = strings.TrimSpace(parte)
			if !strings.HasSuffix(parte, "idle") {
				continue
			}
			campos := strings.Fields(parte)
			if len(campos) < 2 {
				continue
			}
			if v, err := strconv.ParseFloat(strings.TrimSuffix(campos[0], "%"), 64); err == nil {
				ocioso = v // fica a ÚLTIMA ocorrência, que é a amostra real
			}
		}
	}
	if ocioso < 0 {
		return 0
	}
	uso := 100 - ocioso
	if uso < 0 {
		return 0
	}
	if uso > 100 {
		return 100
	}
	return uso
}

// memoriaEmUso soma as páginas que o macOS considera realmente ocupadas.
//
// Usada = ativa + conectada + comprimida. As três são memória que não está
// disponível para outro programa.
//
// `inactive` NÃO entra, e é o ponto que importa: o macOS mantém ali páginas de
// programas que já fecharam, prontas para serem reaproveitadas — contá-las como
// usadas faria todo Mac aparecer com a memória quase cheia o tempo todo, que é
// o mesmo erro do `MemFree` no Linux.
func memoriaEmUso() (int64, int64) {
	saida, err := rodar(context.Background(), 15*time.Second, "vm_stat")
	if err != nil {
		return 0, 0
	}

	paginas := map[string]int64{}
	var tamanho int64 = 4096
	for _, linha := range strings.Split(saida, "\n") {
		if strings.HasPrefix(linha, "Mach Virtual Memory Statistics") {
			if _, resto, ok := strings.Cut(linha, "page size of "); ok {
				if v, err := strconv.ParseInt(strings.Fields(resto)[0], 10, 64); err == nil {
					tamanho = v
				}
			}
			continue
		}
		chave, valor, ok := strings.Cut(linha, ":")
		if !ok {
			continue
		}
		valor = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(valor), "."))
		if v, err := strconv.ParseInt(valor, 10, 64); err == nil {
			paginas[strings.TrimSpace(chave)] = v
		}
	}

	usada := (paginas["Pages active"] +
		paginas["Pages wired down"] +
		paginas["Pages occupied by compressor"]) * tamanho

	total := sysctlInt(context.Background(), "hw.memsize")
	if total <= 0 {
		return 0, 0
	}
	if usada <= 0 || usada > total {
		return 0, total
	}
	return usada, total
}

func volumes() []Volume {
	saida, err := rodar(context.Background(), 20*time.Second, "mount")
	if err != nil {
		return nil
	}

	vistos := map[string]bool{}
	var out []Volume
	for _, linha := range strings.Split(saida, "\n") {
		// "/dev/disk1s5s1 on / (apfs, sealed, local, read-only)"
		_, resto, ok := strings.Cut(linha, " on ")
		if !ok {
			continue
		}
		ponto, tipo, ok := strings.Cut(resto, " (")
		if !ok {
			continue
		}
		ponto = strings.TrimSpace(ponto)
		// `devfs`, `autofs` e companhia não ocupam disco; o Time Machine local
		// aparece e não é volume do usuário.
		if vistos[ponto] || strings.HasPrefix(tipo, "devfs") ||
			strings.HasPrefix(tipo, "autofs") || strings.HasPrefix(ponto, "/System/Volumes/VM") {
			continue
		}

		var st syscall.Statfs_t
		if err := syscall.Statfs(ponto, &st); err != nil {
			continue
		}
		total := int64(st.Blocks) * int64(st.Bsize)
		if total <= 0 {
			continue
		}
		vistos[ponto] = true
		out = append(out, Volume{Ponto: ponto, Total: total, Livre: int64(st.Bavail) * int64(st.Bsize)})
		if len(out) >= 64 {
			break
		}
	}
	return out
}

// servicosFora consulta os daemons do launchd.
//
// `launchctl print` por serviço seria uma chamada por serviço; `launchctl list`
// devolve tudo de uma vez. A primeira coluna é o PID: um traço significa que o
// serviço está carregado mas não está rodando.
func servicosFora(ctx context.Context, servicos []string) []string {
	saida, err := rodar(ctx, 20*time.Second, "launchctl", "list")
	if err != nil {
		return nil
	}

	rodando := map[string]bool{}
	for _, linha := range strings.Split(saida, "\n") {
		campos := strings.Fields(linha)
		if len(campos) < 3 {
			continue
		}
		rodando[campos[2]] = campos[0] != "-"
	}

	var fora []string
	for _, s := range servicos {
		if !rodando[s] {
			fora = append(fora, s)
		}
	}
	return fora
}
