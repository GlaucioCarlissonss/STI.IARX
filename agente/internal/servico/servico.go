// Package servico é o laço que faz o agente ser um agente.
package servico

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand"
	"time"

	"github.com/iartech/sti-agente/internal/atualizacao"
	"github.com/iartech/sti-agente/internal/coleta"
	"github.com/iartech/sti-agente/internal/config"
	"github.com/iartech/sti-agente/internal/envio"
	"github.com/iartech/sti-agente/internal/fila"
)

type Servico struct {
	cfg  config.Config
	id   config.Identidade
	cli  *envio.Cliente
	fila *fila.Fila
	log  *slog.Logger
}

func Novo(cfg config.Config, id config.Identidade, log *slog.Logger) (*Servico, error) {
	f, err := fila.Abrir(config.DiretorioDeDados())
	if err != nil {
		return nil, err
	}
	return &Servico{
		cfg:  cfg,
		id:   id,
		cli:  envio.Novo(cfg.Servidor, coleta.Versao),
		fila: f,
		log:  log,
	}, nil
}

// Rodar é o laço principal. Ele só volta quando o contexto é cancelado.
func (s *Servico) Rodar(ctx context.Context) error {
	if s.id.DeviceToken == "" {
		if err := s.inscrever(ctx); err != nil {
			// Não é fatal: a máquina pode estar sem rede no primeiro minuto depois
			// da instalação, que é justamente quando o instalador sobe o serviço.
			// O laço tenta de novo a cada ciclo.
			s.log.Warn("inscrição adiada", "erro", err)
		}
	}

	/*
	 * A primeira coleta sai imediatamente, e isso é uma decisão de produto: quem
	 * acabou de instalar o agente abre a tela para ver se funcionou. Esperar o
	 * primeiro intervalo faria a tela ficar vazia por um dia, e um recurso que
	 * parece quebrado no primeiro minuto não ganha uma segunda chance.
	 */
	s.ciclarColeta(ctx)

	tCol := time.NewTicker(time.Duration(s.cfg.IntervaloColetaMin) * time.Minute)
	tEnv := time.NewTicker(time.Duration(s.cfg.IntervaloEnvioMin) * time.Minute)
	tAtu := time.NewTicker(12 * time.Hour)
	defer tCol.Stop()
	defer tEnv.Stop()
	defer tAtu.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tCol.C:
			s.ciclarColeta(ctx)
		case <-tEnv.C:
			s.ciclarEnvio(ctx)
		case <-tAtu.C:
			s.ciclarAtualizacao(ctx)
		}
	}
}

func (s *Servico) inscrever(ctx context.Context) error {
	if s.cfg.TokenDeInscricao == "" {
		return errors.New("sem token de inscrição na configuração")
	}

	inv := coleta.Coletar(ctx)
	r, err := s.cli.Inscrever(ctx, s.cfg.TokenDeInscricao, map[string]string{
		"device_uuid":   s.id.DeviceUUID,
		"hostname":      inv.Sistema.Hostname,
		"os":            inv.Sistema.OS,
		"os_version":    inv.Sistema.OSVersion,
		"chassis":       inv.Sistema.Chassi,
		"agent_version": coleta.Versao,
	})
	if err != nil {
		return err
	}

	s.id.DeviceToken = r.DeviceToken
	s.id.DeviceID = r.DeviceID
	if err := config.SalvarIdentidade(s.id); err != nil {
		// Gravar falhou: o token recebido se perde ao reiniciar, e a máquina
		// pediria outro. Não é perda de dado, mas é sinal de disco ou permissão
		// com problema, e precisa aparecer.
		return err
	}
	s.log.Info("máquina inscrita", "device_id", r.DeviceID)
	return nil
}

func (s *Servico) ciclarColeta(ctx context.Context) {
	inv := coleta.Coletar(ctx)
	if inv.Sistema.Hostname == "" {
		// O único campo sem o qual a coleta não serve: sem nome, a máquina não tem
		// como aparecer numa lista.
		s.log.Error("coleta sem hostname, descartada")
		return
	}

	hash, err := fila.HashDoConteudo(inv)
	if err != nil {
		s.log.Error("não consegui resumir a coleta", "erro", err)
		return
	}

	env := coleta.Envelope{ColetadoEm: time.Now().UTC().Format(time.RFC3339), Inventario: inv}
	novo, err := s.fila.Enfileirar(env, hash)
	if err != nil {
		s.log.Error("não consegui enfileirar", "erro", err)
		return
	}
	if novo {
		s.log.Info("inventário mudou, enfileirado", "pendentes", s.fila.Tamanho())
	}

	s.ciclarEnvio(ctx)
}

// ciclarEnvio esvazia a fila e, havendo ou não o que mandar, dá sinal de vida.
func (s *Servico) ciclarEnvio(ctx context.Context) {
	if s.id.DeviceToken == "" {
		if err := s.inscrever(ctx); err != nil {
			s.log.Warn("ainda sem inscrição", "erro", err)
			return
		}
	}

	pendentes := s.fila.Pendentes()
	for _, nome := range pendentes {
		bruto, err := s.fila.Ler(nome)
		if err != nil {
			// Arquivo ilegível fica onde está: apagar esconderia um problema de
			// disco, e um item quebrado não impede os outros de saírem.
			s.log.Error("item da fila ilegível", "item", nome, "erro", err)
			continue
		}

		r, err := s.cli.EnviarInventario(ctx, s.id.DeviceToken, bruto)
		if errors.Is(err, envio.ErrCredencialMorta) {
			s.recredenciar(ctx)
			return
		}
		if err != nil {
			/* Para no primeiro erro em vez de continuar para o próximo: se o
			   servidor está fora do ar, os outros vão falhar igual, e insistir só
			   gastaria a bateria de um notebook sem rede. A ordem também importa —
			   mandar o item 5 antes do 4 inverteria o histórico. */
			s.log.Warn("envio adiado", "item", nome, "erro", err)
			return
		}

		if err := s.fila.Remover(nome); err != nil {
			s.log.Error("entregue mas não consegui remover da fila", "item", nome, "erro", err)
			// Para aqui: continuar reenviaria este mesmo item para sempre.
			return
		}
		s.log.Info("inventário entregue", "status", r.Status)
	}

	if err := s.cli.Batimento(ctx, s.id.DeviceToken); err != nil {
		if errors.Is(err, envio.ErrCredencialMorta) {
			s.recredenciar(ctx)
			return
		}
		s.log.Debug("batimento falhou", "erro", err)
	}
}

// recredenciar lida com o token recusado.
//
// A máquina pode ter sido REVOGADA (e aí a reinscrição também é recusada, e o
// agente simplesmente para de ser aceito — que é o comportamento certo), ou o
// token pode ter sido rotacionado por uma reinstalação em outro lugar. Os dois
// casos chegam como 401, e a tentativa de reinscrição é o que os separa.
func (s *Servico) recredenciar(ctx context.Context) {
	s.log.Warn("o token desta máquina não é mais aceito; tentando reinscrever")
	s.id.DeviceToken = ""
	if err := s.inscrever(ctx); err != nil {
		s.log.Error("reinscrição recusada — a máquina pode ter sido revogada", "erro", err)
	}
}

func (s *Servico) ciclarAtualizacao(ctx context.Context) {
	if !s.cfg.AutoAtualizar {
		return
	}

	/*
	 * Espera de 0 a 30 minutos antes de checar. Sem isso, duzentas máquinas
	 * instaladas pela mesma GPO checariam e baixariam no mesmo minuto — e um
	 * binário de poucos megabytes vezes duzentos, de uma vez, pela ADSL da
	 * filial, é a filial inteira sem rede por meia hora.
	 */
	espera := time.Duration(rand.Intn(30)) * time.Minute //nolint:gosec // dispersão, não segredo
	select {
	case <-ctx.Done():
		return
	case <-time.After(espera):
	}

	p, err := s.cli.VersaoPublicada(ctx)
	if err != nil {
		s.log.Debug("consulta de versão falhou", "erro", err)
		return
	}
	if p == nil {
		return // não há publicação: o estado normal de quem não ligou o recurso
	}

	err = atualizacao.Aplicar(ctx, atualizacao.Publicacao{
		Versao:     p.Versao,
		URL:        p.URL,
		SHA256:     p.SHA256,
		Assinatura: p.Assinatura,
	}, coleta.Versao)

	switch {
	case err == nil:
		s.log.Info("agente atualizado; o serviço será reiniciado pelo sistema", "versao", p.Versao)
		// Sai com código 0: systemd e o gerenciador de serviços do Windows
		// reiniciam, e o binário que sobe é o novo. Reexecutar aqui dentro
		// deixaria dois processos no ar durante a troca.
		defer func() { _ = ctx.Err() }()
	case errors.Is(err, atualizacao.ErrSemChave):
		// Uma vez por ciclo, e em nível de aviso: é configuração, não defeito.
		s.log.Warn("há versão nova publicada, mas este binário não tem chave pública para verificá-la")
	default:
		s.log.Error("atualização recusada", "erro", err)
	}
}

// Batimento esvazia a fila e dá sinal de vida, SEM coletar.
//
// É o modo que a tarefa agendada do Windows chama de dez em dez minutos. A
// separação existe porque coletar é caro e dar sinal de vida é barato: a coleta
// no Windows varre o registro inteiro em busca de programas instalados, e fazer
// isso 144 vezes por dia seria CPU que o usuário sente, para produzir 143 vezes
// o mesmo inventário.
func (s *Servico) Batimento(ctx context.Context) {
	s.ciclarEnvio(ctx)
}

// UmaVez coleta e envia uma vez só.
//
// É o que a GPO chama logo depois da instalação, e o que um técnico roda para
// forçar uma coleta sem esperar o ciclo. Sem isto, "acabei de trocar o pente de
// memória, por que a tela ainda mostra 8 GB?" só teria a resposta "espere até
// amanhã".
func (s *Servico) UmaVez(ctx context.Context) {
	s.ciclarColeta(ctx)
}

// Diagnostico imprime o que o agente vê, sem mandar nada.
//
// Existe porque a primeira pergunta de toda implantação é "por que esta máquina
// não aparece na tela?", e a resposta quase sempre está na coleta ou na rede. Um
// comando que mostra as duas evita uma sessão de acesso remoto.
func (s *Servico) Diagnostico(ctx context.Context) string {
	inv := coleta.Coletar(ctx)
	hash, _ := fila.HashDoConteudo(inv)

	relatorio := map[string]any{
		"versao_do_agente":              coleta.Versao,
		"servidor":                      s.cfg.Servidor,
		"device_uuid":                   s.id.DeviceUUID,
		"inscrita":                      s.id.DeviceToken != "",
		"itens_na_fila":                 s.fila.Tamanho(),
		"hash_do_conteudo":              hash,
		"hostname":                      inv.Sistema.Hostname,
		"numero_serie":                  inv.Sistema.NumeroSerie,
		"programas_lidos":               len(inv.Software),
		"discos_lidos":                  len(inv.Discos),
		"auto_atualizar":                s.cfg.AutoAtualizar,
		"chave_de_assinatura_compilada": atualizacao.ChavePublica != "",
	}
	if s.id.DeviceToken != "" {
		if err := s.cli.Batimento(ctx, s.id.DeviceToken); err != nil {
			relatorio["contato_com_o_servidor"] = err.Error()
		} else {
			relatorio["contato_com_o_servidor"] = "ok"
		}
	}

	bruto, _ := json.MarshalIndent(relatorio, "", "  ")
	return string(bruto)
}
