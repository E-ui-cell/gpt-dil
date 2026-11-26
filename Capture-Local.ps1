#requires -Version 5.1
$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$Port = 9222
$DebugUrl = "http://127.0.0.1:$Port/json/version"
$Profile = Join-Path $env:LOCALAPPDATA "GPT-DIL\ChromeProfile"
$Output = Join-Path $env:USERPROFILE "Documents\GPT-DIL-Captures"

$Node = Get-Command node.exe -ErrorAction SilentlyContinue
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $Node -or -not $Npm) {
    throw "Node.js 22 or newer is required. Install Node.js, then run this script again."
}
$NodeVersionText = (& $Node.Source --version) -replace "^v", ""
if ([version]$NodeVersionText -lt [version]"22.0") {
    throw "Node.js 22 or newer is required. Current version: $NodeVersionText"
}

$ChromeCandidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)
$Chrome = $ChromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) {
    throw "Google Chrome was not found."
}

$Existing = $null
try {
    $Existing = Invoke-RestMethod -Uri $DebugUrl -TimeoutSec 2
} catch {}
if ($Existing) {
    throw "Port $Port is already in use. Close the Chrome instance using that debugging port before starting GPT-DIL."
}

New-Item -ItemType Directory -Force -Path $Profile, $Output | Out-Null

Write-Host ""
Write-Host "GPT-DIL LOCAL CAPTURE" -ForegroundColor Cyan
Write-Host "A separate Chrome profile will be used: $Profile"
Write-Host "Sign into ChatGPT in that window if needed."
Write-Host "Conversation text and streamed responses will be saved locally."
Write-Host "Credentials, cookies and authorization header values are excluded."
Write-Host "Do not upload the capture folder to the public GitHub repository or Releases."
Write-Host ""

$Arguments = @(
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--user-data-dir=`"$Profile`"",
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
    throw "Chrome remote debugging did not start on port $Port."
}

Push-Location $RepoRoot
try {
    if (-not (Test-Path (Join-Path $RepoRoot "node_modules\playwright"))) {
        & $Npm.Source install --no-save --no-package-lock --no-audit --no-fund playwright
        if ($LASTEXITCODE -ne 0) {
            throw "Playwright installation failed."
        }
    }

    $env:GPT_DIL_CDP_URL = "http://127.0.0.1:$Port"
    $env:GPT_DIL_LOCAL_OUTPUT_DIR = $Output
    & $Node.Source (Join-Path $RepoRoot "tools\capture-local-chrome.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "Local capture exited with an error."
    }
}
finally {
    Pop-Location
}
