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

# Reuse the capture browser left running by a previous attempt when it uses
# this exact profile. Otherwise choose an unused localhost debugging port.
$BrowserAlreadyRunning = $false
$Port = $null

for ($CandidatePort = 9222; $CandidatePort -le 9299; $CandidatePort++) {
    $CandidateUrl = "http://127.0.0.1:$CandidatePort/json/version"
    $Endpoint = $null
    try {
        $Endpoint = Invoke-RestMethod -Uri $CandidateUrl -TimeoutSec 2
    } catch {}

    if ($Endpoint) {
        # Do not attach to an unrelated browser or another local debugging service.
        $MatchingProcess = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $_.ExecutablePath -ieq $Chrome -and
                $_.CommandLine -and
                $_.CommandLine.IndexOf($Profile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $_.CommandLine.IndexOf("--remote-debugging-port=$CandidatePort", [StringComparison]::OrdinalIgnoreCase) -ge 0
            } |
            Select-Object -First 1

        if ($MatchingProcess) {
            $Port = $CandidatePort
            $BrowserAlreadyRunning = $true
            Write-Host "Reusing the existing GPT-DIL Supermium session on port $Port."
            break
        }

        Write-Host "Port $CandidatePort is occupied by another process; checking the next port." -ForegroundColor Yellow
        continue
    }

    # Probe whether a non-DevTools process has bound the port.
    $Listener = $null
    try {
        $Listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $CandidatePort)
        $Listener.Start()
        $Listener.Stop()
        $Port = $CandidatePort
        break
    } catch {
        if ($Listener) {
            try { $Listener.Stop() } catch {}
        }
    }
}

if ($null -eq $Port) {
    throw "No free remote-debugging port was found between 9222 and 9299."
}
$DebugUrl = "http://127.0.0.1:$Port/json/version"

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
if (-not $BrowserAlreadyRunning) {
    Start-Process -FilePath $Chrome -ArgumentList $Arguments
}

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
    $NodeErrorLog = Join-Path $DataRoot "capture-node-stderr.log"
    Remove-Item -LiteralPath $NodeLog, $NodeErrorLog -Force -ErrorAction SilentlyContinue
    Write-Host "Node diagnostics: $NodeLog"
    Write-Host "Node stderr:      $NodeErrorLog"
    & $Node.Source (Join-Path $RepoRoot "tools\capture-local-chrome.mjs") 2> $NodeErrorLog |
        Tee-Object -FilePath $NodeLog
    $CaptureExitCode = $LASTEXITCODE
    if (Test-Path -LiteralPath $NodeErrorLog) {
        Get-Content -LiteralPath $NodeErrorLog | Tee-Object -FilePath $NodeLog -Append
    }
    if ($CaptureExitCode -ne 0) {
        throw "Node capture failed with exit code $CaptureExitCode. See $NodeLog"
    }
}
finally {
    Pop-Location
}
