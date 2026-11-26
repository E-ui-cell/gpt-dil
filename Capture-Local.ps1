#requires -Version 5.1
$ErrorActionPreference = "Stop"

# GPT-DIL local capture configuration.
# Capture profile and all capture output are kept under the current user's Desktop.
$Chrome = "C:\Users\Jeroen\Documents\Supermium\chrome.exe"
$Desktop = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($Desktop)) {
    throw "Could not resolve the Desktop directory."
}

$DataRoot = Join-Path $Desktop "GPT-DIL-Capture"
$Profile = Join-Path $DataRoot "Supermium-Profile"
$Output = Join-Path $DataRoot "Captures"
$NpmCache = Join-Path $DataRoot "npm-cache"

$RepoRoot = $PSScriptRoot
$Port = 9222
$DebugUrl = "http://127.0.0.1:$Port/json/version"

if (-not (Test-Path -LiteralPath $Chrome -PathType Leaf)) {
    throw "Supermium was not found at the configured path: $Chrome"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "tools\capture-local-chrome.mjs") -PathType Leaf)) {
    throw "GPT-DIL capture files were not found beside this script. Run it from the GPT-DIL repository folder."
}

$Node = Get-Command node.exe -ErrorAction SilentlyContinue
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $Node -or -not $Npm) {
    throw "Node.js 22 or newer (including npm) is required. No installer is run automatically."
}

$NodeVersionText = (& $Node.Source --version) -replace "^v", ""
if ([version]$NodeVersionText -lt [version]"22.0") {
    throw "Node.js 22 or newer is required. Current version: $NodeVersionText"
}

# Refuse to attach to, or interfere with, another process using this CDP port.
$Existing = $null
try {
    $Existing = Invoke-RestMethod -Uri $DebugUrl -TimeoutSec 2
} catch {}
if ($Existing) {
    throw "Port $Port is already serving a Chrome DevTools endpoint. Close that browser instance or change the port in this script."
}

New-Item -ItemType Directory -Force -Path $DataRoot, $Profile, $Output, $NpmCache | Out-Null

Write-Host ""
Write-Host "GPT-DIL LOCAL CAPTURE" -ForegroundColor Cyan
Write-Host "Browser:       $Chrome"
Write-Host "Browser data:  $Profile"
Write-Host "Capture files: $Output"
Write-Host "NPM cache:     $NpmCache"
Write-Host ""
Write-Host "A separate Supermium profile will be used. Sign into ChatGPT in that window."
Write-Host "Your normal Supermium profile will not be opened or modified."
Write-Host "Conversation text and streamed responses may be included in the capture."
Write-Host "Keep the capture folder private. Do not upload it to the public repository."
Write-Host ""

$Arguments = @(
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    ('--user-data-dir="{0}"' -f $Profile),
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
)
Start-Process -FilePath $Chrome -ArgumentList $Arguments

$Ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $null = Invoke-RestMethod -Uri $DebugUrl -TimeoutSec 2
        $Ready = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $Ready) {
    throw "Supermium remote debugging did not start on port $Port."
}

Push-Location $RepoRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "node_modules\playwright"))) {
        Write-Host "Installing the Playwright package into the GPT-DIL repository folder (no global install)." -ForegroundColor Yellow
        $env:npm_config_cache = $NpmCache
        & $Npm.Source install --no-save --no-package-lock --no-audit --no-fund playwright
        if ($LASTEXITCODE -ne 0) {
            throw "Playwright package installation failed."
        }
    }

    $env:GPT_DIL_CDP_URL = "http://127.0.0.1:$Port"
    $env:GPT_DIL_LOCAL_OUTPUT_DIR = $Output

    $NodeLog = Join-Path $DataRoot "capture-node.log"
    Remove-Item -LiteralPath $NodeLog -Force -ErrorAction SilentlyContinue
    Write-Host "Node diagnostics: $NodeLog"
    & $Node.Source (Join-Path $RepoRoot "tools\capture-local-chrome.mjs") 2>&1 |
        Tee-Object -FilePath $NodeLog
    $CaptureExitCode = $LASTEXITCODE
    if ($CaptureExitCode -ne 0) {
        throw "Node capture failed with exit code $CaptureExitCode. Full diagnostics: $NodeLog"
    }
}
finally {
    Pop-Location
}
