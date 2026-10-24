// Comando sti-agente: o agente de inventário do STI.
//
// Ele é um serviço sem janela. Roda em segundo plano, coleta o inventário da
// máquina uma vez por dia, manda o que mudou e dá sinal de vida a cada dez
// minutos.
//
// # Como ele é instalado
//
// Pelo instalador (MSI no Windows, .deb/.rpm no Linux, .pkg no macOS), que grava
// `agente.json` com o endereço do servidor e o token de inscrição do lote e sobe
// o serviço. Ver `agente/README.md`.
//
// # O que ele NÃO faz
//
// Não lê conteúdo de arquivo, não acompanha navegação, não captura tela e não
// abre porta nenhuma para receber conexão. Ele só fala de dentro para fora, para
// um endereço só, e o que ele manda é hardware, sistema e lista de programas
// instalados. Isso está escrito aqui porque é a primeira pergunta de quem
// autoriza a instalação — e porque limitar o escopo é mais fácil de prometer
// agora do que de desfazer depois.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/iartech/sti-agente/internal/coleta"
	"github.com/iartech/sti-agente/internal/config"
	"github.com/iartech/sti-agente/internal/servico"
)

func main() {
	var (
		mostrarVersao = flag.Bool("versao", false, "imprime a versão e sai")
		diagnosticar  = flag.Bool("diagnostico", false, "mostra o que o agente vê, sem enviar inventário")
		umaVez        = flag.Bool("uma-vez", false, "coleta e envia uma vez, e sai")
		batimento     = flag.Bool("batimento", false, "esvazia a fila e dá sinal de vida, sem coletar, e sai")
		verboso       = flag.Bool("verboso", false, "registro em nível de depuração")
	)
	flag.Parse()

	/*
	 * `--versao` precisa ser a PRIMEIRA coisa, antes de ler configuração.
	 *
	 * É a ordem que a autoatualização exige: o binário candidato é executado com
	 * esta bandeira para se apresentar, e nesse momento ele ainda não tem
	 * configuração nenhuma garantida. Se o programa tentasse ler `agente.json`
	 * antes de responder, toda atualização falharia no teste de sanidade — e
	 * falharia de um jeito que parece defeito do binário novo.
	 */
	if *mostrarVersao {
		fmt.Println(coleta.Versao)
		return
	}

	nivel := slog.LevelInfo
	if *verboso {
		nivel = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: nivel}))

	cfg, err := config.Carregar()
	if err != nil {
		log.Error("configuração", "erro", err)
		os.Exit(1)
	}

	id, err := config.CarregarIdentidade()
	if err != nil {
		log.Error("identidade", "erro", err)
		os.Exit(1)
	}

	s, err := servico.Novo(cfg, id, log)
	if err != nil {
		log.Error("iniciando", "erro", err)
		os.Exit(1)
	}

	// Encerra limpo em SIGTERM: é o sinal que systemd e o gerenciador de serviços
	// do Windows mandam ao parar o serviço, e sair no meio de uma gravação da fila
	// deixaria um arquivo temporário para trás.
	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()

	switch {
	case *diagnosticar:
		fmt.Println(s.Diagnostico(ctx))
	case *batimento:
		s.Batimento(ctx)
	case *umaVez:
		s.UmaVez(ctx)
	default:
		log.Info("agente iniciado",
			"versao", coleta.Versao,
			"servidor", cfg.Servidor,
			"coleta_min", cfg.IntervaloColetaMin,
			"envio_min", cfg.IntervaloEnvioMin)
		if err := s.Rodar(ctx); err != nil && ctx.Err() == nil {
			log.Error("agente parou", "erro", err)
			os.Exit(1)
		}
		log.Info("agente encerrado")
	}
}
