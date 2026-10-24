//go:build windows

package coleta

import (
	"context"
	"strconv"
	"strings"
	"time"
)

/*
As métricas no Windows saem de contadores de desempenho, via PowerShell.

Como no inventário, o custo é o tempo de subida do PowerShell — aqui pago a cada
cinco minutos em vez de uma vez por dia. É a parte mais cara deste agente, e a
alternativa (uma biblioteca de PDH, que exige cgo) foi descartada pela mesma
razão de sempre: dependência num programa que roda como SYSTEM na máquina do
cliente.

Para pagar uma subida só, as três leituras saem de **uma** chamada que devolve um
objeto JSON. Três chamadas separadas triplicariam o custo sem melhorar nada.

Este arquivo não foi executado em Windows. Compila, e as consultas são as
documentadas pela Microsoft.
*/

type estadoWindows struct {
	CPU      float64 `json:"cpu"`
	MemLivre any     `json:"mem_livre_kb"`
	MemTotal any     `json:"mem_total_kb"`
	Volumes  []struct {
		Ponto string `json:"ponto"`
		Total any    `json:"total"`
		Livre any    `json:"livre"`
	} `json:"volumes"`
}

const consultaEstado = `
$os = Get-CimInstance Win32_OperatingSystem
# Uma amostra do contador de processador. O '\\Processor(_Total)\\% Processor Time'
# da primeira leitura vem zerado por desenho do PDH, então são duas amostras e
# fica a segunda — é o equivalente exato do que o Linux faz lendo /proc/stat duas
# vezes.
$cpu = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 2 |
        Select-Object -ExpandProperty CounterSamples |
        Select-Object -Last 1).CookedValue
$vols = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
          ForEach-Object { [pscustomobject]@{ ponto = $_.DeviceID; total = $_.Size; livre = $_.FreeSpace } })
[pscustomobject]@{
  cpu          = [math]::Round($cpu, 1)
  mem_livre_kb = $os.FreePhysicalMemory
  mem_total_kb = $os.TotalVisibleMemorySize
  volumes      = $vols
} | ConvertTo-Json -Compress -Depth 4`

// estadoAtual é lido uma vez por amostra e repartido entre as três funções.
//
// Variável de pacote e não parâmetro porque a interface `Amostrar` é comum às
// três plataformas, e Linux não precisa de nada disso. O agente é um processo só
// com uma amostragem por vez, então não há concorrência a proteger.
var ultimoEstado estadoWindows

func cpuPercentual(ctx context.Context) float64 {
	ultimoEstado = estadoWindows{}
	// 60 s: `Get-Counter` com duas amostras de 1 s leva ~3 s, mais a subida do
	// PowerShell. O prazo largo cobre máquina sobrecarregada sem travar o agente.
	if err := psJSON(ctx, 60*time.Second, consultaEstado, &ultimoEstado); err != nil {
		return 0
	}
	if ultimoEstado.CPU < 0 {
		return 0
	}
	if ultimoEstado.CPU > 100 {
		return 100
	}
	return ultimoEstado.CPU
}

func memoriaEmUso() (int64, int64) {
	// `Win32_OperatingSystem` dá os dois em KILOBYTES, não em bytes. Tratar como
	// bytes faria toda máquina do parque aparecer com 16 MB de memória.
	total := paraInt64(ultimoEstado.MemTotal) * 1024
	livre := paraInt64(ultimoEstado.MemLivre) * 1024
	if total <= 0 {
		return 0, 0
	}
	if livre <= 0 || livre > total {
		return 0, total
	}
	return total - livre, total
}

func volumes() []Volume {
	var out []Volume
	for _, v := range ultimoEstado.Volumes {
		ponto := strings.TrimSpace(v.Ponto)
		total := paraInt64(v.Total)
		if ponto == "" || total <= 0 {
			continue
		}
		out = append(out, Volume{Ponto: ponto, Total: total, Livre: paraInt64(v.Livre)})
	}
	return out
}

// servicosFora consulta os serviços do Windows pelo nome curto.
//
// O nome curto ("Spooler") e não o de exibição ("Spooler de Impressão"): o de
// exibição muda com o idioma do sistema, e uma configuração que funciona no
// Windows em português falharia calada no mesmo parque com uma máquina em inglês.
func servicosFora(ctx context.Context, servicos []string) []string {
	var aspas []string
	for _, s := range servicos {
		// Aspas simples dobradas: é como PowerShell escapa aspas dentro de
		// string literal. Um nome de serviço com aspas quebraria o comando — e
		// o nome vem do arquivo de configuração, que um administrador edita.
		aspas = append(aspas, "'"+strings.ReplaceAll(s, "'", "''")+"'")
	}

	consulta := "@(Get-Service -Name " + strings.Join(aspas, ",") +
		" -ErrorAction SilentlyContinue | Select-Object Name,Status) | ConvertTo-Json -Compress"

	type servicoPS struct {
		Nome   string `json:"Name"`
		Status any    `json:"Status"`
	}
	var ss []servicoPS
	if err := psJSON(ctx, 30*time.Second, consulta, &ss); err != nil {
		return nil
	}

	estado := map[string]bool{}
	for _, s := range ss {
		// `Status` vem como número (4 = Running) ou como texto, conforme a versão
		// do PowerShell. Tratar só um dos dois faria metade do parque reportar
		// todos os serviços fora do ar.
		rodando := false
		switch t := s.Status.(type) {
		case float64:
			rodando = int(t) == 4
		case string:
			rodando = strings.EqualFold(t, "Running")
		}
		estado[strings.ToLower(s.Nome)] = rodando
	}

	var fora []string
	for _, s := range servicos {
		// Serviço que não existe na máquina conta como fora: ou alguém o
		// desinstalou (que é o alerta que se quer), ou a configuração tem um nome
		// errado (que também precisa aparecer). Silêncio seria pior que os dois.
		if !estado[strings.ToLower(s)] {
			fora = append(fora, s)
		}
	}
	return fora
}

func paraFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	default:
		return 0
	}
}
