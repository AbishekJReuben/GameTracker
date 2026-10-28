$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
# Give the existing GameTracker startup time to bring its shared server up.
# Reuse it when healthy; never terminate another owner's listener at sign-in.
for($attempt=0;$attempt -lt 15;$attempt++) {
    try {
        $health=Invoke-RestMethod 'http://127.0.0.1:8080/offroader/health' -TimeoutSec 2
        if($health.service -eq 'offroader' -and $health.protocol -eq 2){exit 0}
    } catch {}
    Start-Sleep -Seconds 2
}
if(Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue){
    throw 'Discovery port8080 is occupied by a server without the Offroader namespace. Restart Discovery Control Center.'
}
& (Join-Path $repo 'scripts/Start-DiscoveryPublic.ps1') -SkipBuild -UseCustomDomain -SkipTunnel
