param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$remote = & git -C $repo remote get-url origin
if ($LASTEXITCODE -ne 0 -or $remote -notmatch '^https://(?:rcheol@)?github\.com/rcheol/elo(?:\.git)?/?$') {
    throw 'Expected the HoneyServe HTTPS origin; no settings were changed.'
}

$previousNoProxy = $env:NO_PROXY
$gitExitCode = 1
try {
    # Use the already configured company proxy only for GitHub, preserving intranet exclusions.
    if ($env:HTTPS_PROXY -or $env:ALL_PROXY) {
        $env:NO_PROXY = (($previousNoProxy -split ',') | Where-Object {
            $_.Trim() -notin @('github.com', '.github.com')
        }) -join ','
    }

    $pushArgs = @(
        '-C', $repo,
        '-c', 'http.version=HTTP/1.1',
        '-c', 'http.sslBackend=schannel',
        '-c', 'http.sslVerify=true',
        'push', '--verbose'
    )
    if ($DryRun) { $pushArgs += '--dry-run' }
    $pushArgs += @('origin', 'main')
    & git @pushArgs
    $gitExitCode = $LASTEXITCODE
} finally {
    $env:NO_PROXY = $previousNoProxy
}
exit $gitExitCode
