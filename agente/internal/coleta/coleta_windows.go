//go:build windows

package coleta

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

/*
A coleta no Windows passa por PowerShell, e isso merece explicação.

## Por que não WMI direto

Falar WMI de dentro do Go exige COM, que exige cgo ou uma biblioteca de terceiro.
Cgo quebra a compilação cruzada (o binário de Windows deixa de sair de uma
máquina Linux) e obriga a ter um compilador C de Windows no caminho; a biblioteca
de terceiro é uma dependência num programa que roda como SYSTEM na máquina do
cliente — ver o comentário do `go.mod`.

## Por que não `wmic`

Ele foi marcado como obsoleto pela Microsoft e já não vem instalado por padrão nas
versões recentes do Windows. Um agente que dependesse dele funcionaria nas
máquinas antigas do parque e falharia calado nas novas, que é o pior dos dois
mundos: o defeito aparece justamente onde ninguém foi olhar.

## O que isso custa

Cada consulta abre um processo de PowerShell, e PowerShell demora quase um
segundo para subir. Como a coleta inteira roda uma vez por dia, o custo é de uns
poucos segundos por dia — e em troca não há dependência, não há cgo e não há
obsolescência.

## O que eu NÃO pude verificar

Este arquivo não foi executado em Windows. Ele compila (a compilação cruzada é
parte da verificação), e as consultas são as documentadas pela Microsoft, mas a
primeira execução em máquina real pode exigir ajuste de nome de propriedade.
Está escrito aqui em vez de omitido porque descobrir isso na implantação é
diferente de descobrir lendo.
*/

// psJSON roda uma consulta e decodifica a saída como JSON.
//
// `-NoProfile` é obrigatório: perfil de PowerShell é script que o administrador
// da máquina pode ter editado, e rodá-lo dentro de um serviço com privilégio
// significa executar código de terceiro em cada coleta. `-NonInteractive` evita
// que uma consulta mal formada pare esperando entrada para sempre.
func psJSON(ctx context.Context, prazo time.Duration, consulta string, destino any) error {
	saida, err := rodar(ctx, prazo, "powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", consulta)
	if err != nil {
		return err
	}
	texto := strings.TrimSpace(saida)
	if texto == "" {
		return nil
	}
	return json.Unmarshal([]byte(texto), destino)
}

func coletarPlataforma(ctx context.Context, inv *Inventario) {
	type sistemaPS struct {
		Fabricante string `json:"Manufacturer"`
		Modelo     string `json:"Model"`
		Dominio    string `json:"Domain"`
		Usuario    string `json:"UserName"`
		MemoriaStr any    `json:"TotalPhysicalMemory"`
	}
	var s sistemaPS
	_ = psJSON(ctx, 30*time.Second,
		`Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,Domain,UserName,TotalPhysicalMemory | ConvertTo-Json -Compress`,
		&s)
	inv.Sistema.Fabricante = s.Fabricante
	inv.Sistema.Modelo = s.Modelo
	inv.Sistema.Dominio = s.Dominio
	// `UserName` vem como DOMINIO\usuario. O inventário quer o usuário.
	if _, usuario, achou := strings.Cut(s.Usuario, `\`); achou {
		inv.Sistema.UsuarioLogado = usuario
	} else {
		inv.Sistema.UsuarioLogado = s.Usuario
	}
	if n := paraInt64(s.MemoriaStr); n > 0 {
		inv.Memoria = &Memoria{TotalBytes: n}
	}

	type biosPS struct {
		Fabricante string `json:"Manufacturer"`
		Versao     string `json:"SMBIOSBIOSVersion"`
		Serial     string `json:"SerialNumber"`
	}
	var b biosPS
	_ = psJSON(ctx, 30*time.Second,
		`Get-CimInstance Win32_BIOS | Select-Object Manufacturer,SMBIOSBIOSVersion,SerialNumber | ConvertTo-Json -Compress`,
		&b)
	inv.Sistema.NumeroSerie = b.Serial
	// Na Dell, a service tag É o número de série do SMBIOS. Repetir nos dois
	// campos é melhor que escolher um: quem procura por "service tag" acha, e
	// quem procura por número de série também.
	inv.Sistema.ServiceTag = b.Serial
	inv.BIOS = &BIOS{Fabricante: b.Fabricante, Versao: b.Versao, Modo: modoDeBoot(ctx)}

	type soPS struct {
		Caption string `json:"Caption"`
		Build   string `json:"BuildNumber"`
		Versao  string `json:"Version"`
	}
	var so soPS
	_ = psJSON(ctx, 30*time.Second,
		`Get-CimInstance Win32_OperatingSystem | Select-Object Caption,BuildNumber,Version | ConvertTo-Json -Compress`,
		&so)
	inv.Sistema.OSVersion = strings.TrimSpace(so.Caption + " " + so.Versao)
	inv.Sistema.OSBuild = so.Build

	type chassiPS struct {
		Tipos []int `json:"ChassisTypes"`
	}
	var ch chassiPS
	_ = psJSON(ctx, 20*time.Second,
		`Get-CimInstance Win32_SystemEnclosure | Select-Object ChassisTypes | ConvertTo-Json -Compress`,
		&ch)
	if len(ch.Tipos) > 0 {
		inv.Sistema.Chassi = chassiNormalizado(strconv.Itoa(ch.Tipos[0]))
	}

	type cpuPS struct {
		Nome     string `json:"Name"`
		Nucleos  int    `json:"NumberOfCores"`
		Logicos  int    `json:"NumberOfLogicalProcessors"`
		Clock    int    `json:"MaxClockSpeed"`
		Arquitet int    `json:"Architecture"`
	}
	var cpus []cpuPS
	_ = psJSON(ctx, 30*time.Second,
		`@(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,Architecture) | ConvertTo-Json -Compress`,
		&cpus)
	if len(cpus) > 0 {
		p := &Processador{Modelo: cpus[0].Nome, FrequenciaMHz: cpus[0].Clock}
		for _, c := range cpus {
			p.Nucleos += c.Nucleos
			p.Threads += c.Logicos
		}
		inv.Processador = p
	}

	inv.Discos = discosWindows(ctx)
	inv.Rede = redeWindows(ctx)
	inv.Software = programasInstalados(ctx)
}

// modoDeBoot distingue UEFI de BIOS legado.
//
// A variável de ambiente `firmware_type` é a fonte que o próprio Windows expõe, e
// não exige consulta nenhuma. Ela não existe nas versões mais antigas, e aí o
// campo fica "desconhecido" em vez de um chute.
func modoDeBoot(ctx context.Context) string {
	saida, err := rodar(ctx, 15*time.Second, "powershell.exe",
		"-NoProfile", "-NonInteractive", "-Command", `$env:firmware_type`)
	if err != nil {
		return "desconhecido"
	}
	switch strings.ToLower(strings.TrimSpace(saida)) {
	case "uefi":
		return "uefi"
	case "legacy":
		return "legacy"
	default:
		return "desconhecido"
	}
}

func discosWindows(ctx context.Context) []Disco {
	type discoPS struct {
		Numero     int    `json:"DeviceId"`
		Modelo     string `json:"FriendlyName"`
		Tamanho    any    `json:"Size"`
		TipoMidia  string `json:"MediaType"`
		Barramento string `json:"BusType"`
		Saude      string `json:"HealthStatus"`
	}
	var ds []discoPS
	/* `Get-PhysicalDisk` dá o estado de saúde já resumido pelo próprio Windows —
	   que é exatamente o que a tela quer, e muito melhor que interpretar 30
	   atributos SMART crus em Go. */
	_ = psJSON(ctx, 45*time.Second,
		`@(Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,Size,MediaType,BusType,HealthStatus) | ConvertTo-Json -Compress`,
		&ds)

	var out []Disco
	for _, d := range ds {
		disco := Disco{
			Dispositivo:  "PhysicalDrive" + strconv.Itoa(d.Numero),
			Modelo:       d.Modelo,
			TamanhoBytes: paraInt64(d.Tamanho),
			Tipo:         "desconhecido",
			Saude:        "desconhecido",
		}
		switch strings.ToUpper(d.Barramento) {
		case "NVME":
			disco.Tipo = "nvme"
		default:
			switch strings.ToUpper(d.TipoMidia) {
			case "SSD":
				disco.Tipo = "ssd"
			case "HDD":
				disco.Tipo = "hdd"
			}
		}
		switch strings.ToLower(d.Saude) {
		case "healthy":
			disco.Saude = "ok"
		case "warning":
			disco.Saude = "atencao"
		case "unhealthy":
			disco.Saude = "falha"
		}
		if disco.TamanhoBytes > 0 {
			out = append(out, disco)
		}
	}
	return out
}

func redeWindows(ctx context.Context) []Rede {
	type redePS struct {
		Nome string `json:"Name"`
		MAC  string `json:"MacAddress"`
		Tipo string `json:"MediaType"`
	}
	var rs []redePS
	_ = psJSON(ctx, 30*time.Second,
		`@(Get-NetAdapter -Physical | Select-Object Name,MacAddress,MediaType) | ConvertTo-Json -Compress`,
		&rs)

	var out []Rede
	for _, r := range rs {
		mac := strings.ReplaceAll(strings.ToLower(r.MAC), "-", ":")
		if mac == "" || mac == "00:00:00:00:00:00" {
			continue
		}
		out = append(out, Rede{Nome: r.Nome, MAC: mac, Tipo: r.Tipo})
	}
	return out
}

// programasInstalados lê o registro, e NÃO a classe `Win32_Product`.
//
// Esta é a decisão menos óbvia e a mais importante deste arquivo.
// `Win32_Product` é a primeira coisa que se acha procurando "listar programas
// instalados com WMI", e **consultá-la dispara uma reconfiguração de todo
// pacote MSI da máquina**: o Windows reavalia cada instalação, o que grava
// evento no log de aplicativo, demora minutos e, em programa mal empacotado,
// chega a reinstalar componente.
//
// Fazer isso uma vez por dia em 200 máquinas de cliente seria um incidente
// recorrente causado pelo agente de inventário — a pior propaganda possível para
// o módulo.
//
// As duas chaves (nativa e de 32 bits) existem porque num Windows de 64 bits os
// programas de 32 bits ficam na WOW6432Node, e ler só uma esconde metade da
// lista — sempre a mesma metade, o que faz o erro parecer dado.
func programasInstalados(ctx context.Context) []Programa {
	const consulta = `$chaves = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
@(Get-ItemProperty $chaves -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Select-Object DisplayName,DisplayVersion,Publisher,InstallDate) | ConvertTo-Json -Compress`

	type programaPS struct {
		Nome       string `json:"DisplayName"`
		Versao     string `json:"DisplayVersion"`
		Fabricante string `json:"Publisher"`
		Data       string `json:"InstallDate"`
	}
	var ps []programaPS
	if err := psJSON(ctx, 2*time.Minute, consulta, &ps); err != nil {
		return nil
	}

	vistos := map[string]bool{}
	var out []Programa
	for _, p := range ps {
		nome := strings.TrimSpace(p.Nome)
		if nome == "" {
			continue
		}
		chave := nome + "\x00" + p.Versao
		// As duas chaves do registro às vezes listam o mesmo programa.
		if vistos[chave] {
			continue
		}
		vistos[chave] = true
		out = append(out, Programa{
			Nome:        nome,
			Versao:      strings.TrimSpace(p.Versao),
			Fabricante:  strings.TrimSpace(p.Fabricante),
			InstaladoEm: dataDoRegistro(p.Data),
		})
	}
	return out
}

// dataDoRegistro converte "20240115" em "2024-01-15".
//
// O registro grava a data de instalação como oito dígitos sem separador, e
// metade dos programas não grava nada. Devolver string vazia no segundo caso é
// melhor que uma data inventada: "instalado em 1970" apareceria em relatório.
func dataDoRegistro(bruto string) string {
	b := strings.TrimSpace(bruto)
	if len(b) != 8 {
		return ""
	}
	if _, err := strconv.Atoi(b); err != nil {
		return ""
	}
	return b[0:4] + "-" + b[4:6] + "-" + b[6:8]
}

// paraInt64 aceita número ou string.
//
// O `ConvertTo-Json` do PowerShell serializa inteiro de 64 bits ora como número,
// ora como string, dependendo da versão e do valor. Tratar só um dos dois
// deixaria o tamanho do disco em zero em metade do parque.
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
	saida, err := rodar(context.Background(), 15*time.Second, "powershell.exe",
		"-NoProfile", "-NonInteractive", "-Command",
		`[int]((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds`)
	if err != nil {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSpace(saida), 10, 64)
	if err != nil {
		return 0
	}
	return n
}
