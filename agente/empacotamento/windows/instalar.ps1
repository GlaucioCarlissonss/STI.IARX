<#
.SYNOPSIS
  Instala o agente de inventário do STI nesta máquina.

.DESCRIPTION
  Faz o mesmo que o MSI: copia o executável, grava a configuração, cria as duas
  tarefas agendadas e dispara a primeira coleta.

  Este é o caminho pronto hoje. O MSI (`sti-agente.wxs`, ao lado) precisa de uma
  máquina Windows com WiX para ser construído, e de um certificado para ser
  assinado; este script não precisa de nenhum dos dois e roda num script de
  inicialização de GPO, que é onde ele é feito para rodar.

.PARAMETER Servidor
  A origem do STI, com https. Ex.: https://sti.iartech.cloud

.PARAMETER Token
  O token de inscrição do lote, emitido na tela "Agentes nas máquinas".

.PARAMETER ServicosCriticos
  Nomes CURTOS dos serviços que esta máquina não pode ficar sem. Ex.:
  -ServicosCriticos Spooler,WinDefend
  Vazio por padrão: não existe lista que sirva para todo mundo, e uma inventada
  por nós produziria alerta em máquina onde o serviço nunca deveria rodar.

.EXAMPLE
  # Numa máquina, com PowerShell como administrador:
  .\instalar.ps1 -Servidor "https://sti.iartech.cloud" -Token "inv_abc..."

.EXAMPLE
  # Em GPO: Configuração do Computador > Scripts > Inicialização
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\dominio\netlogon\sti\instalar.ps1 -Servidor "https://sti.iartech.cloud" -Token "inv_abc..."

.NOTES
  Rodar de novo sobre uma instalação existente é seguro e é o jeito de atualizar
  o executável à mão: o script sobrescreve o binário e as tarefas, e NÃO toca em
  `identidade.json`. Preservar a identidade é o que impede a máquina de virar uma
  segunda linha no inventário a cada reinstalação.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Servidor,
  [Parameter(Mandatory = $true)][string] $Token,
  [int] $IntervaloColetaMin = 1440,
  [int] $IntervaloEnvioMin = 10,
  [int] $IntervaloAmostraMin = 5,
  [string[]] $ServicosCriticos = @(),
  [switch] $AutoAtualizar,
  [string] $Origem = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Destino = Join-Path $env:ProgramFiles 'STI\Agente'
$Dados   = Join-Path $env:ProgramData 'STI\agente'
$Exe     = Join-Path $Destino 'sti-agente.exe'

function Exigir-Administrador {
  $identidade = [Security.Principal.WindowsIdentity]::GetCurrent()
  $papel = New-Object Security.Principal.WindowsPrincipal($identidade)
  if (-not $papel.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Este script precisa ser executado como administrador: ele grava em Arquivos de Programas e cria tarefas que rodam como SYSTEM.'
  }
}

Exigir-Administrador

if ($Servidor -notmatch '^https://') {
  # Não é zelo: o token de inscrição viaja nesta URL. Em http ele viaja em claro.
  throw "O servidor precisa comecar com https:// — recebido: $Servidor"
}

$binarioOrigem = Join-Path $Origem 'sti-agente.exe'
if (-not (Test-Path $binarioOrigem)) {
  throw "Nao encontrei sti-agente.exe em $Origem. Coloque o executavel ao lado deste script."
}

Write-Host 'Criando diretorios...'
New-Item -ItemType Directory -Force -Path $Destino | Out-Null
New-Item -ItemType Directory -Force -Path $Dados   | Out-Null

<#
  O estado fica em ProgramData, e não em Arquivos de Programas.

  O agente escreve a identidade e a fila. Um diretório sob Arquivos de Programas
  é somente leitura para tudo que não seja instalador, e um agente que precisasse
  de permissão de escrita ali seria um agente pedindo elevação em cada coleta.
#>

Write-Host 'Copiando o executavel...'
# As tarefas podem estar rodando. Parar antes evita "arquivo em uso", que é o
# erro que faz uma atualização silenciosa falhar silenciosamente.
foreach ($t in @('STI\Agente - batimento', 'STI\Agente - inventario')) {
  schtasks.exe /End /TN $t 2>$null | Out-Null
}
Copy-Item -Path $binarioOrigem -Destination $Exe -Force

Write-Host 'Gravando a configuracao...'
$config = [ordered]@{
  servidor              = $Servidor.TrimEnd('/')
  token_inscricao       = $Token
  intervalo_coleta_min  = $IntervaloColetaMin
  intervalo_envio_min   = $IntervaloEnvioMin
  intervalo_amostra_min = $IntervaloAmostraMin
  # Nome CURTO do servico ('Spooler'), nunca o de exibicao: o de exibicao muda
  # com o idioma do sistema, e uma configuracao que funciona no Windows em
  # portugues falharia calada no mesmo parque com uma maquina em ingles.
  servicos_criticos     = @($ServicosCriticos)
  auto_atualizar        = [bool]$AutoAtualizar
}
# `ConvertTo-Json` e não concatenação de texto: um token com aspa produziria um
# arquivo malformado, e o agente não subiria sem dizer por quê.
$config | ConvertTo-Json -Compress |
  Set-Content -Path (Join-Path $Dados 'agente.json') -Encoding UTF8 -Force

<#
  As duas tarefas.

  · Batimento, de 10 em 10 minutos: esvazia a fila e diz "estou viva". Custa
    algumas centenas de bytes, e é o que mantém a tela de frota sabendo quem
    parou.

  · Inventário, uma vez por dia às 3h: a coleta varre o registro inteiro em busca
    de programas instalados. Fazer isso 144 vezes por dia seria CPU que o usuário
    sente, para produzir 143 vezes o mesmo inventário.

  `/RU SYSTEM` porque a coleta lê o registro da máquina, não o do usuário logado,
  e porque a tarefa tem de rodar com ninguém logado.
#>
Write-Host 'Criando as tarefas agendadas...'
schtasks.exe /Create /F /TN 'STI\Agente - batimento' /SC MINUTE /MO $IntervaloEnvioMin `
  /RU SYSTEM /RL HIGHEST /TR "`"$Exe`" --batimento" | Out-Null

schtasks.exe /Create /F /TN 'STI\Agente - inventario' /SC DAILY /ST 03:00 `
  /RU SYSTEM /RL HIGHEST /TR "`"$Exe`" --uma-vez" | Out-Null

<#
  A primeira coleta sai agora.

  É decisão de produto: quem acabou de instalar abre a tela para ver se
  funcionou. Esperar as 3h da manhã faria a tela ficar vazia por um dia, e um
  recurso que parece quebrado no primeiro minuto não ganha segunda chance.

  O erro é engolido de propósito — a máquina pode estar sem rede justamente
  durante a instalação, e isso não pode fazer a instalação falhar. A tarefa de
  batimento tentará de novo em dez minutos.
#>
Write-Host 'Primeira coleta...'
try {
  & $Exe --uma-vez 2>&1 | Out-Null
} catch {
  Write-Warning "A primeira coleta nao completou ($($_.Exception.Message)). A tarefa de batimento tentara de novo em $IntervaloEnvioMin minutos."
}

Write-Host ''
Write-Host 'Agente instalado.' -ForegroundColor Green
Write-Host "  Executavel:   $Exe"
Write-Host "  Configuracao: $(Join-Path $Dados 'agente.json')"
Write-Host "  Diagnostico:  `"$Exe`" --diagnostico"
Write-Host ''
Write-Host 'A maquina deve aparecer em "Inventario > Agentes nas maquinas" em ate dez minutos.'
