const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

test("Windows installer updates beside a locked previous FFmpeg without overwriting it", { skip: process.platform !== "win32" }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "megaaroom-installer-"));
  try {
    const installer = path.join(__dirname, "public", "install-local.ps1").replace(/'/g, "''");
    const script = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = '${temp.replace(/'/g, "''")}'
$old = Join-Path $env:LOCALAPPDATA 'MegaRoomAuxiliar/megaaroom-streaming-main/node_modules/ffmpeg-static/ffmpeg.exe'
New-Item -ItemType Directory -Path (Split-Path $old) -Force | Out-Null
Set-Content -LiteralPath $old -Value 'locked original'
$package = Join-Path $env:LOCALAPPDATA 'fixture/megaaroom-streaming-main'
New-Item -ItemType Directory -Path $package -Force | Out-Null
Set-Content -LiteralPath (Join-Path $package 'local-helper.js') -Value '// optimize-existing optimize-season'
$fixture = Join-Path $env:LOCALAPPDATA 'fixture.zip'
Compress-Archive -Path $package -DestinationPath $fixture
function global:Read-Host { return 'https://tv.example.test' }
function global:Invoke-WebRequest { param($Uri, $Headers, $OutFile) Copy-Item -LiteralPath $fixture -Destination $OutFile }
function global:npm.cmd { $global:LASTEXITCODE = 0; Set-Content -LiteralPath (Join-Path (Get-Location) 'ci-marker') -Value 'new dependencies' }
$locked = [IO.File]::Open($old, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try { & '${installer}' -NoStart } finally { $locked.Dispose() }
if ($LASTEXITCODE -ne 0) { throw 'Installer failed' }
$launcher = Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'MegaRoomAuxiliar/Iniciar-MegaRoom.cmd') -Raw
if ($launcher -notmatch 'releases') { throw 'Launcher not switched to a release' }
if ((Get-Content -LiteralPath $old -Raw).Trim() -ne 'locked original') { throw 'Old FFmpeg modified' }
if (@(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'MegaRoomAuxiliar/releases') -Filter 'ci-marker' -Recurse).Count -ne 1) { throw 'Dependencies were not installed in new folder' }
Write-Output 'INSTALLER_LOCK_TEST_OK'
`;
    const { stdout } = await promisify(execFile)(process.env.ComSpec ? "powershell.exe" : "pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30000 });
    assert.match(stdout, /INSTALLER_LOCK_TEST_OK/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
