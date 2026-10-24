//go:build linux

package coleta

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// A coleta no Linux lê `/sys` e `/proc` diretamente, e só recorre a comando
// externo para a lista de pacotes.
//
// Ler o pseudo-sistema de arquivos em vez de chamar `dmidecode`, `lsblk` e
// `lscpu` tem três vantagens que importam numa máquina de cliente: não exige que
// o pacote esteja instalado (servidor mínimo e contêiner não têm nenhum dos
// três), não precisa de root para a maior parte dos campos, e não pode travar —
// é leitura de arquivo, não execução de programa.

const dmi = "/sys/class/dmi/id"

func lerArquivo(caminho string) string {
	b, err := os.ReadFile(caminho) //nolint:gosec // caminhos fixos de /sys e /proc
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func coletarPlataforma(ctx context.Context, inv *Inventario) {
	// --- Identificação da máquina (SMBIOS via /sys, sem dmidecode) ----------
	inv.Sistema.Fabricante = lerArquivo(filepath.Join(dmi, "sys_vendor"))
	inv.Sistema.Modelo = lerArquivo(filepath.Join(dmi, "product_name"))
	inv.Sistema.NumeroSerie = lerArquivo(filepath.Join(dmi, "product_serial"))
	inv.Sistema.Chassi = chassiNormalizado(lerArquivo(filepath.Join(dmi, "chassis_type")))

	// --- Sistema operacional ------------------------------------------------
	inv.Sistema.OSVersion = versaoDoSistema()
	inv.Sistema.OSBuild = lerArquivo("/proc/sys/kernel/osrelease")
	inv.Sistema.Dominio = lerArquivo("/proc/sys/kernel/domainname")
	if inv.Sistema.Dominio == "(none)" {
		inv.Sistema.Dominio = ""
	}
	inv.Sistema.UsuarioLogado = usuarioLogado(ctx)

	// --- BIOS ---------------------------------------------------------------
	modo := "legacy"
	if _, err := os.Stat("/sys/firmware/efi"); err == nil {
		modo = "uefi"
	}
	inv.BIOS = &BIOS{
		Fabricante: lerArquivo(filepath.Join(dmi, "bios_vendor")),
		Versao:     lerArquivo(filepath.Join(dmi, "bios_version")),
		Data:       lerArquivo(filepath.Join(dmi, "bios_date")),
		Modo:       modo,
	}

	inv.Processador = processador()
	inv.Memoria = memoria()
	inv.Discos = discos()
	inv.Rede = interfacesDeRede()
	inv.Software = pacotes(ctx)
}

func versaoDoSistema() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()

	s := bufio.NewScanner(f)
	for s.Scan() {
		if valor, achou := strings.CutPrefix(s.Text(), "PRETTY_NAME="); achou {
			return strings.Trim(valor, `"`)
		}
	}
	return ""
}

// usuarioLogado pergunta ao systemd quem está na sessão gráfica.
//
// Não há fonte boa para isto no Linux: `/var/run/utmp` tem formato binário que
// varia por libc, e a variável de ambiente não existe num serviço. `loginctl` é
// a resposta certa onde há systemd, e onde não há o campo simplesmente fica
// vazio — que é melhor que um palpite errado sobre quem usa a máquina.
func usuarioLogado(ctx context.Context) string {
	saida, err := rodar(ctx, 5*time.Second, "loginctl", "list-sessions", "--no-legend")
	if err != nil {
		return ""
	}
	for _, linha := range strings.Split(saida, "\n") {
		campos := strings.Fields(linha)
		// id  uid  user  seat ...  — sessão com assento é sessão de quem está na
		// frente da máquina; sessão de SSH não tem, e não é "o usuário desta
		// máquina" no sentido que o inventário quer.
		if len(campos) >= 4 && strings.HasPrefix(campos[3], "seat") {
			return campos[2]
		}
	}
	return ""
}

func processador() *Processador {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()

	p := &Processador{}
	soquetes := map[string]bool{}
	var threads int
	var idFisico, coresPorSoquete string

	s := bufio.NewScanner(f)
	for s.Scan() {
		chave, valor, achou := strings.Cut(s.Text(), ":")
		if !achou {
			continue
		}
		chave = strings.TrimSpace(chave)
		valor = strings.TrimSpace(valor)
		switch chave {
		case "model name":
			if p.Modelo == "" {
				p.Modelo = valor
			}
		case "processor":
			threads++
		case "physical id":
			idFisico = valor
			soquetes[valor] = true
		case "cpu cores":
			coresPorSoquete = valor
		case "cpu MHz":
			if p.FrequenciaMHz == 0 {
				if mhz, err := strconv.ParseFloat(valor, 64); err == nil {
					p.FrequenciaMHz = int(mhz)
				}
			}
		}
	}
	_ = idFisico

	p.Threads = threads
	// Núcleos físicos = soquetes × núcleos por soquete. Contar as linhas
	// `processor` daria o número de threads, e relatar 16 núcleos numa máquina de
	// 8 faria a capacidade do parque parecer o dobro do que é.
	if n, err := strconv.Atoi(coresPorSoquete); err == nil && n > 0 {
		quantos := len(soquetes)
		if quantos == 0 {
			quantos = 1
		}
		p.Nucleos = n * quantos
	} else {
		p.Nucleos = threads
	}
	if p.Modelo == "" && p.Threads == 0 {
		return nil
	}
	return p
}

func memoria() *Memoria {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()

	s := bufio.NewScanner(f)
	for s.Scan() {
		if valor, achou := strings.CutPrefix(s.Text(), "MemTotal:"); achou {
			campos := strings.Fields(valor)
			if len(campos) >= 1 {
				if kb, err := strconv.ParseInt(campos[0], 10, 64); err == nil {
					return &Memoria{TotalBytes: kb * 1024}
				}
			}
		}
	}
	return nil
}

func discos() []Disco {
	entradas, err := os.ReadDir("/sys/block")
	if err != nil {
		return nil
	}

	var out []Disco
	for _, e := range entradas {
		nome := e.Name()
		// Disco virtual de memória, de laço, de CD e mapeado não é patrimônio.
		if strings.HasPrefix(nome, "loop") || strings.HasPrefix(nome, "ram") ||
			strings.HasPrefix(nome, "sr") || strings.HasPrefix(nome, "zram") ||
			strings.HasPrefix(nome, "dm-") || strings.HasPrefix(nome, "md") {
			continue
		}
		base := filepath.Join("/sys/block", nome)

		d := Disco{
			Dispositivo: "/dev/" + nome,
			Modelo:      lerArquivo(filepath.Join(base, "device", "model")),
			Saude:       "desconhecido",
		}
		// `size` vem em setores de 512 bytes SEMPRE, independentemente do setor
		// físico do disco. É o contrato do kernel, e tratá-lo como setor de 4 K
		// multiplicaria por oito o tamanho de todo NVMe moderno.
		if setores, err := strconv.ParseInt(lerArquivo(filepath.Join(base, "size")), 10, 64); err == nil {
			d.TamanhoBytes = setores * 512
		}
		rotacional := lerArquivo(filepath.Join(base, "queue", "rotational"))
		switch {
		case strings.HasPrefix(nome, "nvme"):
			d.Tipo = "nvme"
		case rotacional == "0":
			d.Tipo = "ssd"
		case rotacional == "1":
			d.Tipo = "hdd"
		default:
			d.Tipo = "desconhecido"
		}
		if d.TamanhoBytes > 0 {
			out = append(out, d)
		}
	}
	return out
}

func interfacesDeRede() []Rede {
	entradas, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return nil
	}

	var out []Rede
	for _, e := range entradas {
		nome := e.Name()
		if nome == "lo" {
			continue
		}
		mac := lerArquivo(filepath.Join("/sys/class/net", nome, "address"))
		// MAC todo zero é interface virtual sem endereço, e um endereço desses
		// repetido em 200 máquinas não identifica nada.
		if mac == "" || mac == "00:00:00:00:00:00" {
			continue
		}
		tipo := "cabo"
		if _, err := os.Stat(filepath.Join("/sys/class/net", nome, "wireless")); err == nil {
			tipo = "wifi"
		}
		out = append(out, Rede{Nome: nome, MAC: mac, Tipo: tipo})
	}
	return out
}

// pacotes lê a lista de software do gerenciador que existir.
//
// Não há caminho único: Debian e derivados usam dpkg, Red Hat e derivados usam
// rpm, Alpine usa apk. Tentar os três e usar o que responder é mais simples (e
// mais confiável) que detectar a distribuição primeiro — detectar exige um mapa
// de distribuições que precisa ser mantido, e tentar não exige nada.
func pacotes(ctx context.Context) []Programa {
	tentativas := []struct {
		bin    string
		args   []string
		separa func(string) []Programa
	}{
		{"dpkg-query", []string{"-W", "-f=${Package}\t${Version}\t${Maintainer}\n"}, tabulado},
		{"rpm", []string{"-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n"}, tabulado},
		{"apk", []string{"info", "-v"}, apkInfo},
	}

	for _, t := range tentativas {
		// Dois minutos: `rpm -qa` numa máquina com milhares de pacotes e disco
		// lento passa de trinta segundos com folga.
		saida, err := rodar(ctx, 2*time.Minute, t.bin, t.args...)
		if err != nil {
			continue
		}
		if p := t.separa(saida); len(p) > 0 {
			return p
		}
	}
	return nil
}

func tabulado(saida string) []Programa {
	var out []Programa
	for _, linha := range strings.Split(saida, "\n") {
		campos := strings.Split(linha, "\t")
		if len(campos) < 2 || strings.TrimSpace(campos[0]) == "" {
			continue
		}
		p := Programa{Nome: strings.TrimSpace(campos[0]), Versao: strings.TrimSpace(campos[1])}
		if len(campos) >= 3 {
			f := strings.TrimSpace(campos[2])
			if f != "(none)" {
				p.Fabricante = f
			}
		}
		out = append(out, p)
	}
	return out
}

func apkInfo(saida string) []Programa {
	var out []Programa
	for _, linha := range strings.Split(saida, "\n") {
		linha = strings.TrimSpace(linha)
		if linha == "" {
			continue
		}
		// `nome-1.2.3-r0`: o nome é tudo antes dos dois últimos hífens.
		corte := strings.LastIndex(linha, "-")
		if corte <= 0 {
			continue
		}
		corte = strings.LastIndex(linha[:corte], "-")
		if corte <= 0 {
			continue
		}
		out = append(out, Programa{Nome: linha[:corte], Versao: linha[corte+1:]})
	}
	return out
}

func tempoLigado() int64 {
	campos := strings.Fields(lerArquivo("/proc/uptime"))
	if len(campos) == 0 {
		return 0
	}
	segundos, err := strconv.ParseFloat(campos[0], 64)
	if err != nil {
		return 0
	}
	return int64(segundos)
}
