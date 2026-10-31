<#
.SYNOPSIS
    Atualiza a ponte para o código novo da branch e a sobe de novo.

.DESCRIPTION
    A ponte não tem deploy automático: o que roda é o que foi compilado neste
    computador. Este script para a tarefa (e a ponte que ela subiu), traz o
    código só se ele seguir em linha reta (git pull --ff-only), reinstala as
    dependências do lock (npm ci), compila e inicia a tarefa de novo.

    Se o git pull falhar, nada mudou e a tarefa volta a rodar como estava. Se o
    npm ci ou a compilação falharem, a tarefa fica parada: resolva e rode de
    novo. A sessão do WhatsApp, o cursor e o .env não são tocados.
#>
[CmdletBinding()]
param(
    [string] $NomeDaTarefa = 'Financas Zap'
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
$alvo = Join-Path $raiz 'dist\index.js'

Write-Host "Ponte: $raiz"

$tarefa = Get-ScheduledTask -TaskName $NomeDaTarefa -ErrorAction SilentlyContinue
if (-not $tarefa) {
    throw "A tarefa `"$NomeDaTarefa`" não está instalada (npm run windows:instalar)."
}

function Get-Descendentes {
    param([int] $Pai, [object[]] $Todos)

    $filhos = $Todos | Where-Object { $_.ParentProcessId -eq $Pai }
    foreach ($filho in $filhos) {
        $filho
        Get-Descendentes -Pai $filho.ProcessId -Todos $Todos
    }
}

function Stop-Ponte {
    if ((Get-ScheduledTask -TaskName $NomeDaTarefa).State -eq 'Running') {
        Write-Host 'Parando a tarefa...'
        Stop-ScheduledTask -TaskName $NomeDaTarefa
    }

    # Parar a tarefa encerra o wscript; o node e o Chrome que ele subiu podem
    # ficar para trás, e a ponte nova encontraria a trava de uma viva.
    $processos = Get-CimInstance Win32_Process
    $pontes = $processos | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -and
        $_.CommandLine.IndexOf($alvo, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    foreach ($ponte in $pontes) {
        Write-Host ("Encerrando a ponte que ficou de pé (processo {0})..." -f $ponte.ProcessId)
        $familia = @(Get-Descendentes -Pai $ponte.ProcessId -Todos $processos) + @($ponte)
        foreach ($processo in $familia) {
            Stop-Process -Id $processo.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Wait-Process -Id $ponte.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    }
}

function Invoke-Passo {
    param([string] $Descricao, [scriptblock] $Comando)

    Write-Host $Descricao
    & $Comando
    if ($LASTEXITCODE -ne 0) {
        throw "$Descricao falhou (código $LASTEXITCODE)."
    }
}

Push-Location $raiz
try {
    $antes = (& git rev-parse --short HEAD)
    Stop-Ponte

    try {
        Invoke-Passo 'Trazendo o código novo (git pull --ff-only)...' { & git pull --ff-only }
    } catch {
        Write-Warning 'O git pull não andou; nada mudou. A ponte volta como estava.'
        Start-ScheduledTask -TaskName $NomeDaTarefa
        throw
    }

    try {
        Invoke-Passo 'Reinstalando as dependências (npm ci)...' { & npm ci }
        Invoke-Passo 'Compilando a ponte...' { & npm run build }
    } catch {
        Write-Warning 'A tarefa ficou parada. Resolva o erro acima e rode npm run windows:atualizar de novo.'
        throw
    }

    $depois = (& git rev-parse --short HEAD)
    Start-ScheduledTask -TaskName $NomeDaTarefa
} finally {
    Pop-Location
}

Write-Host ''
Write-Host "Pronto: $antes -> $depois. A tarefa `"$NomeDaTarefa`" subiu a ponte de novo."
Write-Host 'Para ver como ela está:   npm run windows:situacao'
