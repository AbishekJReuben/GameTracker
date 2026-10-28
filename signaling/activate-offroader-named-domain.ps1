param([int]$WaitSeconds=60)
$ErrorActionPreference='Stop'
$runtime=Join-Path $PSScriptRoot 'offroader-runtime'
$public='https://discovery.chilloutgamestudio.com'
$deadline=[datetime]::UtcNow.AddSeconds($WaitSeconds)
$ready=$false
while([datetime]::UtcNow -lt $deadline) {
    try {
        $health=Invoke-RestMethod ($public+'/offroader/health') -TimeoutSec 4
        if($health.service -eq 'offroader' -and $health.protocol -eq 2){$ready=$true;break}
    } catch {}
    Start-Sleep -Seconds 2
}
if(-not $ready){throw 'The upgraded discovery server is not active yet. Restart it from Discovery Control Center.'}
# Only retire the separately owned game sidecar. The named tunnel and existing
# discovery server are never stopped here.
& (Join-Path $PSScriptRoot 'serve-offroader.ps1') -Action Stop
$manifest=Join-Path $PSScriptRoot 'static/offroader.json'
$data=@{owner='offroader-shared-world-v1';protocol=2;endpoint='wss://discovery.chilloutgamestudio.com/offroader/ws';transport='wss';capabilities=@($health.capabilities);generation=[guid]::NewGuid().ToString();updated_utc=[datetime]::UtcNow.ToString('o');temporary_transport=$false}
[IO.File]::WriteAllText($manifest+'.tmp',($data|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath ($manifest+'.tmp') -Destination $manifest -Force
$startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'Offroader Shared World.lnk'
if(Test-Path -LiteralPath $startup){Remove-Item -LiteralPath $startup}
[IO.File]::WriteAllText((Join-Path $runtime 'named-domain-activation.json'),($data|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Write-Output 'OFFROADER_NAMED_DOMAIN_READY wss://discovery.chilloutgamestudio.com/offroader/ws'
