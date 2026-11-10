param([switch]$NoStart)
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
    # Every install gets its own dependencies so an active FFmpeg is never unlinked.
    $releaseId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $releaseRoot = Join-Path (Join-Path $installRoot 'releases') $releaseId
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    $archive = Join-Path $releaseRoot 'download.zip'
    Write-Host 'Baixando auxiliar e instalando FFmpeg. Aguarde...'
    $downloadUrl = 'https://github.com/leo9694/megaaroom-streaming/archive/refs/heads/main.zip?refresh=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Invoke-WebRequest $downloadUrl -Headers @{ 'Cache-Control' = 'no-cache' } -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $releaseRoot
    $appRoot = Join-Path $releaseRoot 'megaaroom-streaming-main'
    if (!(Select-String -LiteralPath (Join-Path $appRoot 'local-helper.js') -Pattern 'optimize-existing' -Quiet)) {
        throw 'O download trouxe uma versao antiga. Baixe o instalador novamente no site atualizado.'
    }
    Push-Location -LiteralPath $appRoot
    try {
        & npm.cmd ci --omit=dev
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar a nova copia do FFmpeg. A instalacao anterior foi preservada. Verifique espaco em disco, antivirus e acesso a internet.' }
        & node --check (Join-Path $appRoot 'local-helper.js')
        if ($LASTEXITCODE -ne 0) { throw 'Auxiliar baixado invalido. O atalho anterior foi preservado.' }
        $nodePath = (Get-Command node).Source
        $launcher = '@echo off' + "`r`n" + '"' + $nodePath + '" "' + (Join-Path $appRoot 'local-helper.js') + '" "' + $siteOrigin + '"' + "`r`npause`r`n"
        $launcherPath = Join-Path $installRoot 'Iniciar-MegaRoom.cmd'
        Set-Content -LiteralPath ($launcherPath + '.tmp') -Value $launcher -Encoding ASCII
        Move-Item -LiteralPath ($launcherPath + '.tmp') -Destination $launcherPath -Force
        Write-Host 'Instalacao concluida. Seus trabalhos e a instalacao anterior foram preservados.'
        if (!$NoStart) {
            $existing = Get-NetTCPConnection -LocalPort 43123 -State Listen -ErrorAction SilentlyContinue
            if ($existing) {
                Write-Host 'O auxiliar anterior ainda esta aberto. Aguarde os trabalhos terminarem, feche a janela antiga e abra Iniciar-MegaRoom.cmd para usar esta versao e este dominio.' -ForegroundColor Yellow
                Read-Host 'Pressione Enter para fechar o instalador'
            } else {
                Write-Host 'Copie o codigo exibido abaixo para o site. Mantenha esta janela aberta.'
                & node local-helper.js $siteOrigin
            }
        }
    } finally { Pop-Location }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (!$NoStart) { Read-Host 'Pressione Enter para fechar' }
    exit 1
}
