package fila

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

/*
A fila de métricas é um arquivo, e não um diretório.

## Por que diferente da fila de inventário

São dois problemas diferentes vestindo o mesmo nome.

O inventário produz **poucos itens grandes** (um por mudança, raro, com a lista
de programas dentro) e cada um precisa ser entregue individualmente e removido
individualmente. Um arquivo por item é a estrutura certa.

A métrica produz **muitos itens minúsculos** (288 por dia, cada um com alguns
números) que viajam em lote e são descartados em lote. Um arquivo por amostra
seriam 288 arquivos por dia por máquina — e, numa máquina que passou duas
semanas fora da rede, 4.000 arquivos num diretório, cada um com 200 bytes,
gastando um bloco inteiro de disco cada.

Uma linha por amostra num arquivo só resolve os dois: anexar é barato, ler em
ordem é natural, e truncar depois da entrega é uma chamada.

## O corte pelo começo

Quando o arquivo passa do teto, as linhas mais ANTIGAS saem. É a mesma decisão
da fila de inventário e pelo mesmo motivo invertido: ali o que importa é o
estado atual (e o recente nunca é descartado); aqui o que importa é não perder o
recente, porque a métrica velha já não ajuda ninguém a decidir nada.
*/

type FilaDeMetricas struct {
	caminho string
	teto    int
}

// TetoDeAmostras: com uma amostra a cada 5 minutos, 4.000 são quase duas
// semanas. Cobre férias de um notebook com folga, e limita o arquivo a menos de
// um megabyte.
const TetoDeAmostras = 4000

func AbrirMetricas(diretorioDeDados string) (*FilaDeMetricas, error) {
	if err := os.MkdirAll(diretorioDeDados, 0o700); err != nil {
		return nil, fmt.Errorf("criando %s: %w", diretorioDeDados, err)
	}
	return &FilaDeMetricas{
		caminho: filepath.Join(diretorioDeDados, "metricas.jsonl"),
		teto:    TetoDeAmostras,
	}, nil
}

// Anexar grava uma amostra no fim do arquivo.
func (f *FilaDeMetricas) Anexar(amostra any) error {
	bruto, err := json.Marshal(amostra)
	if err != nil {
		return err
	}
	/*
	 * O formato de uma linha por amostra depende de nenhuma amostra conter uma
	 * quebra de linha crua — e quem garante isso é `json.Marshal`, que escapa
	 * `\n` dentro de texto e compacta `json.RawMessage`.
	 *
	 * A primeira versão deste código conferia de novo aqui, "por garantia". A
	 * conferência era inalcançável: não existe entrada para a qual `Marshal`
	 * devolva uma quebra de linha. Código defensivo que não pode disparar é o
	 * mesmo tipo de peso morto que esta base já removeu do catálogo de permissões
	 * — ele custa uma varredura por amostra e dá a impressão de que o invariante
	 * é frágil quando ele é da biblioteca padrão. O que ficou foi a asserção, em
	 * `metricas_test.go`, provando que uma amostra com quebra de linha no
	 * conteúdo vira uma linha só e volta inteira.
	 */
	if len(bruto) == 0 {
		return fmt.Errorf("amostra vazia")
	}

	arq, err := os.OpenFile(f.caminho, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) //nolint:gosec
	if err != nil {
		return fmt.Errorf("abrindo a fila de métricas: %w", err)
	}
	defer func() { _ = arq.Close() }()

	if _, err := arq.Write(append(bruto, '\n')); err != nil {
		return fmt.Errorf("gravando amostra: %w", err)
	}
	return nil
}

// Ler devolve até `limite` amostras, da mais antiga para a mais nova.
//
// Devolve `json.RawMessage` e não a estrutura: quem chama vai remontar o lote e
// mandar, e desserializar para serializar de novo só gastaria tempo — e abriria
// a chance de uma versão nova do agente mudar o formato de uma amostra que a
// versão anterior gravou.
func (f *FilaDeMetricas) Ler(limite int) ([]json.RawMessage, error) {
	arq, err := os.Open(f.caminho) //nolint:gosec // caminho fixo
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // fila vazia é o caso normal
		}
		return nil, err
	}
	defer func() { _ = arq.Close() }()

	var out []json.RawMessage
	s := bufio.NewScanner(arq)
	// Uma amostra cabe folgado em 64 KB; o padrão do Scanner também. O limite
	// explícito existe para o arquivo corrompido não virar alocação sem teto.
	s.Buffer(make([]byte, 0, 4096), 64*1024)

	for s.Scan() {
		linha := s.Bytes()
		if len(linha) == 0 {
			continue
		}
		// Linha ilegível é PULADA, não fatal: uma queda de energia no meio de um
		// `write` deixa uma linha parcial no fim do arquivo, e ela não pode
		// impedir as 3.999 anteriores de serem entregues.
		if !json.Valid(linha) {
			continue
		}
		copia := make([]byte, len(linha))
		copy(copia, linha)
		out = append(out, copia)
		if len(out) >= limite {
			break
		}
	}
	return out, nil
}

// Descartar remove as `n` primeiras linhas — as que acabaram de ser entregues.
//
// Reescreve o arquivo inteiro, o que é aceitável porque ele tem menos de um
// megabyte e isso acontece uma vez a cada dez minutos. A alternativa (um
// deslocamento guardado à parte) seria mais rápida e teria dois estados para
// manter em sincronia, que é onde moram os bugs deste tipo de estrutura.
func (f *FilaDeMetricas) Descartar(n int) error {
	if n <= 0 {
		return nil
	}

	arq, err := os.Open(f.caminho) //nolint:gosec // caminho fixo
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var restantes [][]byte
	s := bufio.NewScanner(arq)
	s.Buffer(make([]byte, 0, 4096), 64*1024)
	i := 0
	for s.Scan() {
		linha := s.Bytes()
		if len(linha) == 0 {
			continue
		}
		if json.Valid(linha) {
			i++
			if i <= n {
				continue
			}
		}
		copia := make([]byte, len(linha))
		copy(copia, linha)
		restantes = append(restantes, copia)
	}
	_ = arq.Close()

	return f.reescrever(restantes)
}

// Podar corta o excesso pelo começo, deixando as mais recentes.
func (f *FilaDeMetricas) Podar() error {
	linhas, err := f.todasAsLinhas()
	if err != nil || len(linhas) <= f.teto {
		return err
	}
	return f.reescrever(linhas[len(linhas)-f.teto:])
}

func (f *FilaDeMetricas) Tamanho() int {
	linhas, err := f.todasAsLinhas()
	if err != nil {
		return 0
	}
	return len(linhas)
}

func (f *FilaDeMetricas) todasAsLinhas() ([][]byte, error) {
	arq, err := os.Open(f.caminho) //nolint:gosec // caminho fixo
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = arq.Close() }()

	var linhas [][]byte
	s := bufio.NewScanner(arq)
	s.Buffer(make([]byte, 0, 4096), 64*1024)
	for s.Scan() {
		if len(s.Bytes()) == 0 || !json.Valid(s.Bytes()) {
			continue
		}
		copia := make([]byte, len(s.Bytes()))
		copy(copia, s.Bytes())
		linhas = append(linhas, copia)
	}
	return linhas, nil
}

// reescrever troca o arquivo por um novo, atomicamente.
//
// Gravar por cima do original deixaria a fila truncada no meio se a energia
// caísse — e a fila truncada no meio é a fila perdida. O rename ou acontece
// inteiro ou não acontece.
func (f *FilaDeMetricas) reescrever(linhas [][]byte) error {
	if len(linhas) == 0 {
		if err := os.Remove(f.caminho); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}

	temp := f.caminho + ".novo"
	arq, err := os.OpenFile(temp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600) //nolint:gosec
	if err != nil {
		return err
	}
	w := bufio.NewWriter(arq)
	for _, l := range linhas {
		if _, err := w.Write(append(l, '\n')); err != nil {
			_ = arq.Close()
			_ = os.Remove(temp)
			return err
		}
	}
	if err := w.Flush(); err != nil {
		_ = arq.Close()
		_ = os.Remove(temp)
		return err
	}
	if err := arq.Close(); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return os.Rename(temp, f.caminho)
}
