// Package fila guarda o que ainda não foi entregue.
package fila

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

/*
A fila local é um diretório de arquivos JSON, um por coleta.

## Por que não SQLite

Seria a escolha automática, e seria a errada aqui. SQLite em Go ou precisa de cgo
(que quebra a compilação cruzada e exige compilador C de Windows) ou de uma
reimplementação em Go puro, que é uma dependência grande num programa que roda
como serviço privilegiado na máquina do cliente.

E o que esta estrutura precisa fazer é: anexar no fim, ler em ordem, apagar da
frente. É uma fila, não um banco. Um diretório de arquivos faz isso com `rename`
e `remove`, que são atômicos nos três sistemas, e cabe em duzentas linhas que dá
para ler inteiras.

## Por que a coleta igual não é enfileirada

O notebook em viagem coleta todo dia e não consegue mandar. Se cada coleta virasse
um arquivo, trinta dias fora do ar seriam trinta arquivos com conteúdo idêntico —
e, ao voltar, trinta requisições para o servidor responder "unchanged" trinta
vezes. O hash do conteúdo corta isso na origem.

O que **é** enfileirado é toda coleta que mudou, e em ordem. É o que preserva a
pergunta "o que mudou nesta máquina?" para uma máquina que passou um mês fora:
sem a fila, as mudanças intermediárias sumiriam e só o estado final chegaria.
*/

type Fila struct {
	dir string
	// teto é o número máximo de coletas guardadas. Agente sem conseguir falar com
	// o servidor por um ano não pode encher o disco do cliente.
	teto int
}

const TetoPadrao = 200

func Abrir(diretorioDeDados string) (*Fila, error) {
	dir := filepath.Join(diretorioDeDados, "fila")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("criando fila em %s: %w", dir, err)
	}
	return &Fila{dir: dir, teto: TetoPadrao}, nil
}

// HashDoConteudo é o mesmo critério que o servidor usa: o conteúdo, sem a hora.
//
// Ele é calculado sobre o JSON do inventário — não do envelope. O envelope
// carrega `coletado_em`, e incluí-lo faria toda coleta parecer diferente de toda
// coleta, que é exatamente o que esta função existe para evitar.
func HashDoConteudo(inventario any) (string, error) {
	bruto, err := json.Marshal(inventario)
	if err != nil {
		return "", err
	}
	soma := sha256.Sum256(bruto)
	return hex.EncodeToString(soma[:]), nil
}

// Enfileirar grava a coleta, se ela for diferente da última enfileirada.
//
// Devolve `false` quando não gravou por ser igual — que é o caso normal e não um
// erro.
func (f *Fila) Enfileirar(envelope any, hash string) (bool, error) {
	if hash == f.ultimoHash() {
		return false, nil
	}

	bruto, err := json.Marshal(envelope)
	if err != nil {
		return false, err
	}

	/*
	 * O nome carrega a hora em formato ordenável e os primeiros caracteres do
	 * hash. A hora dá a ordem (que é o que a fila precisa preservar); o hash
	 * evita colisão quando duas coletas caem no mesmo instante, o que acontece
	 * quando o serviço é reiniciado no meio de um ciclo.
	 */
	nome := fmt.Sprintf("%s-%s.json", time.Now().UTC().Format("20060102T150405.000"), hash[:8])
	temp := filepath.Join(f.dir, "."+nome)
	if err := os.WriteFile(temp, bruto, 0o600); err != nil {
		return false, fmt.Errorf("gravando na fila: %w", err)
	}
	if err := os.Rename(temp, filepath.Join(f.dir, nome)); err != nil {
		_ = os.Remove(temp)
		return false, fmt.Errorf("fechando item da fila: %w", err)
	}

	_ = f.gravarUltimoHash(hash)
	f.podar()
	return true, nil
}

// Pendentes devolve os itens na ordem em que foram coletados.
func (f *Fila) Pendentes() []string {
	entradas, err := os.ReadDir(f.dir)
	if err != nil {
		return nil
	}
	var nomes []string
	for _, e := range entradas {
		nome := e.Name()
		// O ponto na frente marca arquivo em gravação; ele vira item só no rename.
		if e.IsDir() || strings.HasPrefix(nome, ".") || !strings.HasSuffix(nome, ".json") {
			continue
		}
		nomes = append(nomes, nome)
	}
	// O formato da hora no nome é ordenável como texto, de propósito.
	sort.Strings(nomes)
	return nomes
}

func (f *Fila) Ler(nome string) ([]byte, error) {
	return os.ReadFile(filepath.Join(f.dir, filepath.Base(nome))) //nolint:gosec // Base corta travessia
}

func (f *Fila) Remover(nome string) error {
	return os.Remove(filepath.Join(f.dir, filepath.Base(nome)))
}

func (f *Fila) Tamanho() int { return len(f.Pendentes()) }

// podar descarta os itens mais ANTIGOS quando a fila passa do teto.
//
// Descartar o mais antigo e não o mais recente é a escolha certa aqui, e vale
// dizer por quê: o inventário mais recente é o estado real da máquina, e é o que
// o inventário precisa ter. O histórico intermediário é desejável e perdível. A
// decisão oposta deixaria o sistema com um retrato de um ano atrás e a certeza
// de que ele está errado.
func (f *Fila) podar() {
	nomes := f.Pendentes()
	if len(nomes) <= f.teto {
		return
	}
	for _, n := range nomes[:len(nomes)-f.teto] {
		_ = f.Remover(n)
	}
}

func (f *Fila) ultimoHash() string {
	b, err := os.ReadFile(filepath.Join(f.dir, ".ultimo-hash")) //nolint:gosec // caminho fixo
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (f *Fila) gravarUltimoHash(hash string) error {
	return os.WriteFile(filepath.Join(f.dir, ".ultimo-hash"), []byte(hash), 0o600)
}
