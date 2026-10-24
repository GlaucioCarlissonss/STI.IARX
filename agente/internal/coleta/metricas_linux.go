//go:build linux

package coleta

import (
	"bufio"
	"context"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

/*
A medição de CPU no Linux, e por que ela custa 200 ms.

`/proc/stat` guarda CONTADORES acumulados desde o boot, não um percentual. O uso
instantâneo é a diferença entre duas leituras dividida pelo tempo entre elas —
não existe jeito de ler "a CPU está em 40%" numa única passada.

A alternativa seria guardar a leitura anterior entre amostras e comparar com a
atual, o que daria a média dos últimos cinco minutos. Seria mais barato e seria
pior: a média de cinco minutos esconde o pico, e o pico é o que faz a máquina
travar. Duzentos milissegundos a cada cinco minutos é 0,07% de um núcleo.
*/

type estatisticaCPU struct {
	ocupado uint64
	total   uint64
}

func lerCPU() (estatisticaCPU, bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return estatisticaCPU{}, false
	}
	defer func() { _ = f.Close() }()

	s := bufio.NewScanner(f)
	for s.Scan() {
		campos := strings.Fields(s.Text())
		if len(campos) < 5 || campos[0] != "cpu" {
			continue
		}
		var total, ocioso uint64
		for i, c := range campos[1:] {
			v, err := strconv.ParseUint(c, 10, 64)
			if err != nil {
				continue
			}
			total += v
			// Campos 3 e 4 (índices 3 e 4 da fatia) são `idle` e `iowait`.
			// `iowait` conta como ocioso: a CPU não está trabalhando, está
			// esperando o disco — e marcá-la como ocupada faria toda máquina com
			// disco lento parecer sobrecarregada de processamento.
			if i == 3 || i == 4 {
				ocioso += v
			}
		}
		return estatisticaCPU{ocupado: total - ocioso, total: total}, true
	}
	return estatisticaCPU{}, false
}

func cpuPercentual(ctx context.Context) float64 {
	a, ok := lerCPU()
	if !ok {
		return 0
	}

	select {
	case <-ctx.Done():
		return 0
	case <-time.After(200 * time.Millisecond):
	}

	b, ok := lerCPU()
	if !ok || b.total <= a.total {
		return 0
	}

	uso := float64(b.ocupado-a.ocupado) / float64(b.total-a.total) * 100
	if uso < 0 {
		return 0
	}
	if uso > 100 {
		return 100
	}
	return uso
}

// memoriaEmUso devolve (usada, total) em bytes.
//
// Usada = total − `MemAvailable`, e **não** total − `MemFree`. A diferença não é
// detalhe: o Linux usa toda a memória livre como cache de disco, então `MemFree`
// numa máquina saudável fica perto de zero. Relatar isso como "memória usada"
// faria o inventário inteiro aparecer com 98% de memória em uso, e o número
// perderia qualquer utilidade — exatamente o erro que faz tanta gente achar que
// "o Linux come toda a RAM".
func memoriaEmUso() (int64, int64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer func() { _ = f.Close() }()

	var total, disponivel int64
	s := bufio.NewScanner(f)
	for s.Scan() {
		chave, valor, achou := strings.Cut(s.Text(), ":")
		if !achou {
			continue
		}
		campos := strings.Fields(valor)
		if len(campos) == 0 {
			continue
		}
		kb, err := strconv.ParseInt(campos[0], 10, 64)
		if err != nil {
			continue
		}
		switch chave {
		case "MemTotal":
			total = kb * 1024
		case "MemAvailable":
			disponivel = kb * 1024
		}
	}
	if total <= 0 {
		return 0, 0
	}
	if disponivel <= 0 || disponivel > total {
		return 0, total
	}
	return total - disponivel, total
}

func volumes() []Volume {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()

	// Sistemas de arquivos que não ocupam disco de verdade. Sem este filtro, o
	// inventário mostraria `tmpfs` e `overlay` como volumes cheios — e um
	// `/dev/shm` em 100% abriria alerta todo dia sem nada estar errado.
	virtuais := map[string]bool{
		"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true,
		"tmpfs": true, "securityfs": true, "cgroup": true, "cgroup2": true,
		"pstore": true, "debugfs": true, "tracefs": true, "fusectl": true,
		"configfs": true, "mqueue": true, "hugetlbfs": true, "bpf": true,
		"binfmt_misc": true, "autofs": true, "squashfs": true, "ramfs": true,
		"overlay": true, "nsfs": true, "efivarfs": true, "fuse.gvfsd-fuse": true,
	}

	vistos := map[string]bool{}
	var out []Volume

	s := bufio.NewScanner(f)
	for s.Scan() {
		campos := strings.Fields(s.Text())
		if len(campos) < 3 {
			continue
		}
		ponto, tipo := campos[1], campos[2]
		if virtuais[tipo] || vistos[ponto] {
			continue
		}

		var st syscall.Statfs_t
		if err := syscall.Statfs(ponto, &st); err != nil {
			continue
		}
		total := int64(st.Blocks) * st.Bsize
		if total <= 0 {
			continue
		}
		/*
		 * `Bavail` e não `Bfree`: o ext4 reserva 5% dos blocos para o root, e
		 * `Bfree` os inclui. Um disco "cheio" para quem usa a máquina ainda tem
		 * esses 5% livres em `Bfree`, e relatar o número do root faria o alerta
		 * de disco chegar tarde demais — depois de o usuário já não conseguir
		 * gravar nada.
		 */
		livre := int64(st.Bavail) * st.Bsize

		vistos[ponto] = true
		out = append(out, Volume{Ponto: ponto, Total: total, Livre: livre})
		if len(out) >= 64 {
			break
		}
	}
	return out
}

// servicosFora devolve, da lista configurada, as unidades que NÃO estão ativas.
//
// Uma chamada só com todas as unidades, em vez de uma por serviço: `systemctl`
// demora dezenas de milissegundos para subir, e vinte serviços seriam vinte
// processos a cada cinco minutos.
func servicosFora(ctx context.Context, servicos []string) []string {
	args := append([]string{"is-active"}, servicos...)
	// `is-active` sai com código diferente de zero quando QUALQUER unidade está
	// inativa — que é o caso que nos interessa. Por isso a saída é lida mesmo
	// com erro, em vez de descartada.
	saida, _ := rodar(ctx, 20*time.Second, "systemctl", args...)

	linhas := strings.Split(strings.TrimSpace(saida), "\n")
	if len(linhas) != len(servicos) {
		// A resposta não casa com a pergunta: não dá para dizer qual serviço está
		// fora. Devolver nada é melhor que devolver o alerta errado — um alerta
		// apontando o serviço errado manda alguém reiniciar o que estava bom.
		return nil
	}

	var fora []string
	for i, estado := range linhas {
		if strings.TrimSpace(estado) != "active" {
			fora = append(fora, servicos[i])
		}
	}
	return fora
}
