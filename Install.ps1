[CmdletBinding()]
param(
    [string]$InstallPath = (Join-Path $env:LOCALAPPDATA 'GPT-DIL'),
    [switch]$Force,
    [switch]$OpenFolder
)

$ErrorActionPreference = 'Stop'

$archiveUrl = 'https://github.com/E-ui-cell/gpt-dil/archive/refs/heads/main.zip'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('GPT-DIL-' + [guid]::NewGuid().ToString('N'))
$sourceRoot = $PSScriptRoot
$downloadSource = [string]::IsNullOrWhiteSpace($sourceRoot)

if (-not $downloadSource -and (Test-Path -LiteralPath $sourceRoot)) {
    try {
        $sourceFullPath = [IO.Path]::GetFullPath($sourceRoot).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        $installFullPath = [IO.Path]::GetFullPath($InstallPath).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        if ($sourceFullPath -ieq $installFullPath) {
            $downloadSource = $true
        }
    }
    catch {
    }
}

try {
    if ($downloadSource -or
        -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'README.md'))) {

        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

        try {
            [Net.ServicePointManager]::SecurityProtocol =
                [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        }
        catch {
        }

        $archivePath = Join-Path $tempRoot 'gpt-dil.zip'
        Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
        Expand-Archive -LiteralPath $archivePath -DestinationPath $tempRoot -Force

        $sourceRoot = Join-Path $tempRoot 'gpt-dil-main'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'README.md'))) {
        throw 'The GPT-DIL source archive is incomplete.'
    }

    if (Test-Path -LiteralPath $InstallPath) {
        if (-not $Force) {
            throw "Destination already exists. Use -Force to update project files: $InstallPath"
        }
    }
    else {
        New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
    }

    Get-ChildItem -LiteralPath $sourceRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $InstallPath -Recurse -Force
    }

    Write-Host ''
    Write-Host "GPT-DIL installed to: $InstallPath" -ForegroundColor Green
    Write-Host 'No browser settings or extensions were changed.'

    if ($OpenFolder) {
        Start-Process -FilePath explorer.exe -ArgumentList ('"{0}"' -f $InstallPath)
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
