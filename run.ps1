param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 5000
)

$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$localPython = Join-Path $projectDirectory '.venv\Scripts\python.exe'
$existingPython = Join-Path (Split-Path -Parent $projectDirectory) '.venv\Scripts\python.exe'
$pythonArguments = @()

if (Test-Path -LiteralPath $localPython) {
    $pythonCommand = $localPython
} elseif (Test-Path -LiteralPath $existingPython) {
    # Reuse the installed interpreter only; server.py reads this project's .env explicitly.
    $pythonCommand = $existingPython
} else {
    $launcher = Get-Command py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $installedPython = Get-Command python -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notmatch '\\Microsoft\\WindowsApps\\' } |
        Select-Object -First 1
    if ($launcher) {
        $pythonCommand = $launcher.Source
        $pythonArguments = @('-3')
    } elseif ($installedPython) {
        $pythonCommand = $installedPython.Source
    } else {
        Write-Host 'Python 3.10 or newer is required. Install Python, then follow README.md.'
        exit 1
    }
}

Push-Location -LiteralPath $projectDirectory
try {
    & $pythonCommand @pythonArguments -c 'import fastapi, httpx, dotenv, PyPDF2, uvicorn' 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Install the project dependencies first:'
        Write-Host '  python -m venv .venv'
        Write-Host '  .\.venv\Scripts\python.exe -m pip install -r requirements.txt'
        exit 1
    }
    Write-Host "Easy ArXiv: http://127.0.0.1:$Port"
    & $pythonCommand @pythonArguments -m uvicorn server:app --host 127.0.0.1 --port $Port
} finally {
    Pop-Location
}
