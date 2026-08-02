<#
.SYNOPSIS
    Tira a ponte da inicialização do Windows.

.DESCRIPTION
    Encerra a tarefa, se estiver rodando, e a remove do Agendador. Nada do que a
    ponte guarda é apagado: a sessão do WhatsApp, o cursor da caixa e o .env
    continuam onde estão, e `npm start` volta a funcionar na mão.
#>
[CmdletBinding()]
param(
    [string] $NomeDaTarefa = 'Financas Zap'
)

$ErrorActionPreference = 'Stop'

$tarefa = Get-ScheduledTask -TaskName $NomeDaTarefa -ErrorAction SilentlyContinue

if (-not $tarefa) {
    Write-Host "A tarefa `"$NomeDaTarefa`" não está instalada."
    return
}

if ($tarefa.State -eq 'Running') {
    Write-Host 'Encerrando a ponte...'
    Stop-ScheduledTask -TaskName $NomeDaTarefa
}

Unregister-ScheduledTask -TaskName $NomeDaTarefa -Confirm:$false
Write-Host "Tarefa `"$NomeDaTarefa`" removida. A sessão do WhatsApp e o cursor continuam salvos."
