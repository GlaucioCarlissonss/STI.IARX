package coleta

import (
	"context"
	"time"
)

/*
As amostras de desempenho.

## Por que elas não vão junto do inventário

Inventário é configuração: muda poucas vezes por ano, e o servidor só guarda
linha nova quando muda. Métrica é série temporal: muda sempre, e o servidor
agrega e expira. São dois ciclos de vida e dois formatos, e juntá-los faria o
inventário parecer diferente a cada coleta — destruindo exatamente o mecanismo
que torna o histórico de inventário legível.

## O que NÃO é coletado aqui

Nada por processo. "Qual programa está consumindo a CPU" é a pergunta seguinte e
é tentadora, e a resposta carrega o nome e a linha de comando de tudo que a
pessoa está rodando — que é vigilância, não inventário. O agente promete, no
`main.go`, não olhar o que está aberto, e a promessa vale mais que o recurso.
*/

// Volume é um ponto de montagem com espaço.
type Volume struct {
	Ponto string `json:"ponto"`
	Total int64  `json:"total"`
	Livre int64  `json:"livre"`
}

// Amostra é uma leitura instantânea.
//
// Os nomes são curtos de propósito: numa frota de 200 máquinas enviando 288
// amostras por dia, o nome dos campos é uma fração real do tráfego.
type Amostra struct {
	Em string `json:"em"`
	/*
	 * CPU é o único campo numérico SEM `omitempty`, e é deliberado: 0% é uma
	 * leitura legítima — uma máquina ociosa — e `omitempty` a tornaria
	 * indistinguível de "não consegui medir". A diferença importa justamente no
	 * caso que interessa, que é a máquina que vive em 100%: se ela some do
	 * gráfico por um ciclo, é preciso saber se ela ficou quieta ou se a medição
	 * falhou.
	 */
	CPU          float64  `json:"cpu"`
	MemUsada     int64    `json:"mem_usada,omitempty"`
	MemTotal     int64    `json:"mem_total,omitempty"`
	LigadaS      int64    `json:"ligada_s,omitempty"`
	Volumes      []Volume `json:"volumes,omitempty"`
	ServicosFora []string `json:"servicos_fora,omitempty"`
}

// LoteDeMetricas é o corpo da requisição.
type LoteDeMetricas struct {
	Amostras []Amostra `json:"amostras"`
}

// Amostrar lê o estado atual da máquina.
//
// `servicos` é a lista que o cliente configurou como crítica. A coleta devolve
// apenas os que estão FORA — a exceção, não o estado completo: mandar "estes 40
// serviços estão no ar" a cada cinco minutos seria transmitir e gravar a mesma
// lista 100 mil vezes por dia para descobrir o dia em que um sumiu.
//
// Como a coleta de inventário, esta não devolve erro: leitura que falha vira
// campo ausente. Uma amostra sem a memória continua dizendo o que a CPU estava
// fazendo, e meia amostra é melhor que nenhuma.
func Amostrar(ctx context.Context, servicos []string) Amostra {
	a := Amostra{
		Em:      time.Now().UTC().Format(time.RFC3339),
		LigadaS: tempoLigado(),
	}

	a.CPU = cpuPercentual(ctx)
	a.MemUsada, a.MemTotal = memoriaEmUso()
	a.Volumes = volumes()

	if len(servicos) > 0 {
		a.ServicosFora = servicosFora(ctx, servicos)
	}
	return a
}
