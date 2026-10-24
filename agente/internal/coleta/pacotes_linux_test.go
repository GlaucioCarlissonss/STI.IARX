//go:build linux

package coleta

import "testing"

func TestTabuladoLeDpkgERpm(t *testing.T) {
	saida := "bash\t5.2.15-2+b7\tMatthias Klose <doko@debian.org>\n" +
		"coreutils\t9.1-1\t(none)\n" +
		"\t\t\n" +
		"openssl\t3.0.11-1~deb12u2\tDebian OpenSSL Team\n"

	p := tabulado(saida)
	if len(p) != 3 {
		t.Fatalf("esperava 3 pacotes, veio %d: %+v", len(p), p)
	}
	if p[0].Nome != "bash" || p[0].Versao != "5.2.15-2+b7" {
		t.Errorf("primeiro pacote errado: %+v", p[0])
	}
	// `(none)` é como dpkg e rpm dizem "sem mantenedor". Gravar a string literal
	// faria 400 pacotes aparecerem com o fabricante "(none)" na tela.
	if p[1].Fabricante != "" {
		t.Errorf("'(none)' tinha de virar vazio, veio %q", p[1].Fabricante)
	}
}

func TestApkInfoSeparaNomeDaVersao(t *testing.T) {
	// `nome-1.2.3-r0`: o nome é tudo antes dos DOIS últimos hífens, e pacotes com
	// hífen no nome são a regra, não a exceção.
	p := apkInfo("busybox-1.36.1-r15\nca-certificates-bundle-20240226-r0\n\n")
	if len(p) != 2 {
		t.Fatalf("esperava 2, veio %d: %+v", len(p), p)
	}
	if p[0].Nome != "busybox" || p[0].Versao != "1.36.1-r15" {
		t.Errorf("busybox saiu errado: %+v", p[0])
	}
	if p[1].Nome != "ca-certificates-bundle" {
		t.Errorf("pacote com hífen no nome saiu errado: %+v", p[1])
	}
}

func TestLerArquivoInexistenteDevolveVazio(t *testing.T) {
	// Toda a coleta do Linux depende disto: arquivo de /sys que não existe é o
	// caso normal (contêiner não tem DMI, servidor sem EFI não tem /sys/firmware),
	// e não pode virar erro nem pânico.
	if got := lerArquivo("/sys/class/dmi/id/isto-nao-existe"); got != "" {
		t.Errorf("esperava vazio, veio %q", got)
	}
}

func TestDiscosIgnoramDispositivoVirtual(t *testing.T) {
	/*
	 * Roda contra /sys de verdade. Num contêiner a lista costuma vir vazia, e isso
	 * é aceitável — o que NÃO é aceitável é um `loop0` ou um `zram0` aparecendo
	 * como patrimônio, porque aí o inventário mostraria discos que não existem.
	 */
	for _, d := range discos() {
		for _, prefixo := range []string{"/dev/loop", "/dev/ram", "/dev/zram", "/dev/sr", "/dev/dm-", "/dev/md"} {
			if len(d.Dispositivo) >= len(prefixo) && d.Dispositivo[:len(prefixo)] == prefixo {
				t.Errorf("dispositivo virtual %q entrou no inventário", d.Dispositivo)
			}
		}
		if d.TamanhoBytes <= 0 {
			t.Errorf("disco %q com tamanho zero não devia ter entrado", d.Dispositivo)
		}
	}
}

func TestInterfacesIgnoramLoopbackEMacZerado(t *testing.T) {
	for _, r := range interfacesDeRede() {
		if r.Nome == "lo" {
			t.Error("o loopback não é placa de rede")
		}
		if r.MAC == "" || r.MAC == "00:00:00:00:00:00" {
			t.Errorf("MAC inútil entrou: %+v", r)
		}
	}
}
