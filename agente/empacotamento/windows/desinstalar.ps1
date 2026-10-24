<#
.SYNOPSIS
  Remove o agente de inventário do STI desta máquina.

.DESCRIPTION
  Apaga as tarefas, o executável e, por padrão, o estado.

  Revogar a máquina na tela do STI é uma coisa; desinstalar o agente é outra, e
  as duas precisam ser feitas se a intenção é tirar a máquina do parque. Este
  script faz só a segunda: sem a revogação, a máquina fica na tela como
  "silenciosa" para sempre — e "silenciosa" é o estado que também significa
  "parou de funcionar", então a tela deixaria de distinguir as duas coisas.

.PARAMETER PreservarIdentidade
  Mantém `identidade.json`. Use ao reinstalar o agente na MESMA máquina: o UUID
  gravado é o que faz a reinstalação reaproveitar a linha existente em vez de
  criar uma segunda máquina no inventário.

.EXAMPLE
  .\desinstalar.ps1
  .\desinstalar.ps1 -PreservarIdentidade
#>

[CmdletBinding()]
param(
  [switch] $PreservarIdentidade
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$Destino = Join-Path $env:ProgramFiles 'STI\Agente'
$Dados   = Join-Path $env:ProgramData 'STI\agente'

$identidade = [Security.Principal.WindowsIdentity]::GetCurrent()
$papel = New-Object Security.Principal.WindowsPrincipal($identidade)
if (-not $papel.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Este script precisa ser executado como administrador.'
}

Write-Host 'Removendo as tarefas agendadas...'
foreach ($t in @('STI\Agente - batimento', 'STI\Agente - inventario')) {
  schtasks.exe /End    /TN $t 2>$null | Out-Null
  schtasks.exe /Delete /F /TN $t 2>$null | Out-Null
}

Write-Host 'Removendo o executavel...'
if (Test-Path $Destino) {
  Remove-Item -Path $Destino -Recurse -Force -ErrorAction SilentlyContinue
}

if ($PreservarIdentidade) {
  Write-Host 'Preservando identidade.json (reinstalacao nao criara maquina duplicada).'
  Get-ChildItem -Path $Dados -Exclude 'identidade.json' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host 'Removendo o estado...'
  if (Test-Path $Dados) {
    Remove-Item -Path $Dados -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Remove-Item -Path 'HKLM:\SOFTWARE\STI\Agente' -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Agente removido.' -ForegroundColor Green
Write-Host 'Lembre de REVOGAR a maquina em "Inventario > Agentes nas maquinas" —'
Write-Host 'sem isso ela fica na tela como silenciosa para sempre.'
