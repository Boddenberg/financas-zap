<#
.SYNOPSIS
    Faz a ponte subir junto com o Windows, sem janela e sem pesar.

.DESCRIPTION
    Cria uma tarefa no Agendador de Tarefas do usuário atual. Ela sobe a ponte
    um minuto depois do logon e, a cada dez minutos, confere se ela continua de
    pé — se caiu, levanta; se está rodando, não faz nada.

    Não pede administrador: a tarefa é do usuário, roda com o computador ligado
    e desligada com ele. Prioridade abaixo do normal, para que a ponte nunca
    dispute processador com quem está usando a máquina.
#>
[CmdletBinding()]
param(
    [string] $NomeDaTarefa = 'Financas Zap',
    [int] $MinutosEntreConferencias = 10
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$lancador = Join-Path $PSScriptRoot 'financas-zap.vbs'

Write-Host "Ponte: $raiz"

if (-not (Test-Path (Join-Path $raiz '.env'))) {
    throw "Não achei o .env em $raiz. Configure a ponte antes de instalá-la na inicialização."
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'Não achei o node.exe no PATH. Instale o Node.js 20 ou mais recente.'
}

if (-not (Test-Path (Join-Path $raiz 'node_modules'))) {
    Write-Host 'Instalando as dependências...'
    Push-Location $raiz
    try { & npm install } finally { Pop-Location }
}

Write-Host 'Compilando a ponte...'
Push-Location $raiz
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'A compilação falhou; a tarefa não foi criada.' }
} finally {
    Pop-Location
}

$existente = Get-ScheduledTask -TaskName $NomeDaTarefa -ErrorAction SilentlyContinue
if ($existente) {
    Write-Host 'Substituindo a tarefa que já existia...'
    Unregister-ScheduledTask -TaskName $NomeDaTarefa -Confirm:$false
}

$acao = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument ('"{0}"' -f $lancador) `
    -WorkingDirectory $raiz

# Um minuto depois do logon: o Windows ainda está arrumando a casa nesse ponto,
# e a ponte não tem pressa nenhuma.
$aoEntrar = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$aoEntrar.Delay = 'PT1M'

# A rede caiu, o WhatsApp desconectou, o processo morreu: em vez de vigiar a
# ponte com um segundo processo vigiando, o próprio agendador confere de tempos
# em tempos. Como o lançador espera pela ponte, a tarefa fica "em execução"
# enquanto ela viver — e a conferência não sobe uma segunda cópia.
$deTemposEmTempos = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $MinutosEntreConferencias)

$ajustes = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Priority 7

$identidade = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $NomeDaTarefa `
    -Action $acao `
    -Trigger @($aoEntrar, $deTemposEmTempos) `
    -Settings $ajustes `
    -Principal $identidade `
    -Description 'Entrega no WhatsApp as mensagens da Casa e bate o relógio do Finanças.' | Out-Null

Write-Host ''
Write-Host "Pronto. A tarefa `"$NomeDaTarefa`" sobe a ponte a cada logon."
Write-Host 'Para ligar agora, sem esperar o próximo logon:'
Write-Host "    Start-ScheduledTask -TaskName `"$NomeDaTarefa`""
Write-Host ''
Write-Host 'Para ver como ela está:   npm run windows:situacao'
Write-Host 'Para desfazer:            npm run windows:remover'
