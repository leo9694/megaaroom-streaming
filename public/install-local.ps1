$ErrorActionPreference = 'Stop'
try {
    $installRoot = Join-Path $env:LOCALAPPDATA 'MegaRoomAuxiliar'
    $siteText = Read-Host 'Endereco do site (exemplo: https://tv.leogabriel.shop ou http://localhost:3000)'
    $siteUri = [Uri]$siteText
    if ($siteUri.Scheme -notin @('http', 'https') -or !$siteUri.Host) { throw 'Endereco invalido.' }
    $siteOrigin = $siteUri.GetLeftPart([UriPartial]::Authority)
    if (!(Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host 'Node.js e necessario para controlar o FFmpeg. A instalacao pedira sua confirmacao.'
        if (!(Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Instale o Node.js LTS de https://nodejs.org e execute este instalador novamente.' }
        & winget install --id OpenJS.NodeJS.LTS -e --interactive
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    $nodeVersion = & node --version
    if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { throw 'Instale o Node.js LTS (20 ou superior) e tente novamente.' }
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    $archive = Join-Path $installRoot 'download.zip'
    Write-Host 'Baixando auxiliar e instalando FFmpeg. Aguarde...'
    Invoke-WebRequest 'https://github.com/leo9694/megaaroom-streaming/archive/refs/heads/main.zip' -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $installRoot -Force
    $appRoot = Join-Path $installRoot 'megaaroom-streaming-main'
    Push-Location -LiteralPath $appRoot
    try {
        & npm.cmd ci --omit=dev
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependencias ou FFmpeg. Verifique a internet e execute novamente.' }
        $nodePath = (Get-Command node).Source
        $launcher = '@echo off' + "`r`n" + '"' + $nodePath + '" "' + (Join-Path $appRoot 'local-helper.js') + '" "' + $siteOrigin + '"' + "`r`npause`r`n"
        Set-Content -LiteralPath (Join-Path $installRoot 'Iniciar-MegaRoom.cmd') -Value $launcher -Encoding ASCII
        Write-Host 'Instalado. Copie o codigo exibido abaixo para o site. Mantenha esta janela aberta.'
        & node local-helper.js $siteOrigin
    } finally { Pop-Location }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Pressione Enter para fechar'
}
