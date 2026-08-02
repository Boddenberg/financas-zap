<#
.SYNOPSIS
    Diz se a ponte está de pé, quanto ela está pesando e o que ela andou dizendo.

.DESCRIPTION
    Sem janela, a ponte fica invisível: este é o jeito de olhar para ela. Mostra
    o estado da tarefa do Windows, a memória somada do processo e do Chromium
    que ele mantém aberto, e o fim do diário.
#>
[CmdletBinding()]
param(
    [string] $NomeDaTarefa = 'Financas Zap',
    [int] $LinhasDoDiario = 15
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$trava = Join-Path $raiz '.runtime\financas-zap.lock'
$diario = Join-Path $raiz '.runtime\financas-zap.log'

function Get-Descendentes {
    param([int] $Pai, [object[]] $Todos)

    $filhos = $Todos | Where-Object { $_.ParentProcessId -eq $Pai }
    foreach ($filho in $filhos) {
        $filho
        Get-Descendentes -Pai $filho.ProcessId -Todos $Todos
    }
}

Write-Host '--- Tarefa do Windows ---'
$tarefa = Get-ScheduledTask -TaskName $NomeDaTarefa -ErrorAction SilentlyContinue

if ($tarefa) {
    $ultima = Get-ScheduledTaskInfo -TaskName $NomeDaTarefa
    Write-Host ("estado: {0}" -f $tarefa.State)
    Write-Host ("última execução: {0} (resultado {1})" -f $ultima.LastRunTime, $ultima.LastTaskResult)
    Write-Host ("próxima conferência: {0}" -f $ultima.NextRunTime)
} else {
    Write-Host "não instalada (npm run windows:instalar)"
}

Write-Host ''
Write-Host '--- Processo ---'
$processos = Get-CimInstance Win32_Process
$ponte = $processos | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains('dist\index.js')
} | Select-Object -First 1

if ($ponte) {
    $familia = @($ponte) + (Get-Descendentes -Pai $ponte.ProcessId -Todos $processos)
    $memoria = ($familia | Measure-Object -Property WorkingSetSize -Sum).Sum / 1MB
    $desde = $ponte.CreationDate

    Write-Host ("de pé desde {0} (processo {1})" -f $desde, $ponte.ProcessId)
    Write-Host ("{0} processos, {1} MB somados" -f $familia.Count, [math]::Round($memoria, 1))
} else {
    Write-Host 'a ponte não está rodando.'

    if (Test-Path $trava) {
        Write-Host "há uma trava esquecida em $trava; o próximo início a assume."
    }
}

Write-Host ''
Write-Host '--- Diário ---'

if (Test-Path $diario) {
    Get-Content -Path $diario -Tail $LinhasDoDiario -Encoding UTF8
} else {
    Write-Host "ainda não há diário em $diario."
}
