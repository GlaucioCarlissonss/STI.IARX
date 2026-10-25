-- =============================================================================
-- 0044 — Anexo de áudio e vídeo
-- =============================================================================
-- Item M5 da docs/18 §5, listado como "cosmético, e o navegador já abre o
-- arquivo". A segunda metade da frase estava errada por um motivo simples: **o
-- navegador não abre o que nunca foi aceito no upload.**
--
-- `ticket_attachments.kind` aceita 'audio' e 'video' desde a 0013. O bucket, a
-- validação do formulário e a lista de tipos permitidos **não aceitam nenhum
-- dos dois**. A coluna existia com dois valores sem caminho nenhum para chegar
-- lá — a mesma família de defeito que a 0036 corrigiu em seis tabelas.
--
-- POR QUE ISTO DEIXOU DE SER COSMÉTICO
-- -------------------------------------
-- Entre o momento em que aquela nota foi escrita e agora, a Onda 5 trouxe os
-- canais de conversa. Num canal de WhatsApp, o áudio não é um anexo exótico: é
-- como metade das pessoas descreve um problema. "Gravei um áudio explicando" é
-- a forma mais comum de relato em suporte no Brasil.
--
-- Receber esse áudio e não conseguir guardá-lo transforma o canal num lugar
-- onde a informação se perde entre a conversa e o chamado.
--
-- O LIMITE DE 25 MB CONTINUA
-- ---------------------------
-- Ele é por arquivo e não foi afrouxado. Em áudio de voz — que é o caso real —
-- 25 MB são mais de vinte minutos; em vídeo, menos de um minuto em qualidade
-- alta. Quem precisa anexar um vídeo longo continua usando link, e isso é
-- deliberado: o custo de armazenamento de um SaaS multi-tenant é a soma dos
-- anexos de todo mundo, e a cota por empresa (`tenants.attachment_quota_mb`,
-- agora editável em /ambiente) é o que impede um cliente de consumir o bucket
-- inteiro.
-- =============================================================================

begin;

/*
 * Os formatos, e por que exatamente estes.
 *
 * `audio/ogg` e `audio/opus` vêm primeiro na lista de prioridade mental: é o
 * que o WhatsApp entrega num áudio de voz. Sem eles, o caso mais comum seria
 * justamente o que falharia.
 *
 * `video/quicktime` entra porque é o que um iPhone grava, e um relato de
 * suporte filmado quase sempre vem de um celular.
 *
 * O que NÃO entra: `audio/x-wav` e companhia, `video/x-msvideo` (AVI),
 * `video/x-matroska` (MKV). Nenhum deles toca no navegador sem plugin, e aceitar
 * o upload de um arquivo que a pessoa não consegue ouvir na tela é prometer de
 * novo o que não se cumpre.
 */
update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'image/jpeg', 'image/png', 'image/webp', 'image/heic',
     'application/xml', 'text/xml',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/msword',
     'text/plain', 'text/csv',
     -- Áudio: voz, antes de tudo.
     'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm',
     -- Vídeo: o que toca no navegador, e só.
     'video/mp4', 'video/webm', 'video/quicktime'
   ]
 where id = 'anexos';

comment on column public.ticket_attachments.kind is
  'Natureza do anexo. "audio" e "video" existiam desde a 0013 e não tinham como chegar aqui: o bucket os recusava.';

commit;
