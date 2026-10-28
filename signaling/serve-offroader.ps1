param(
    [ValidateSet('Start','Run','Stop','Status')][string]$Action = 'Status',
    [string]$GameTrackerRoot = (Split-Path -Parent $PSScriptRoot),
    [int]$Port = 8081
)
$ErrorActionPreference='Stop'
$runtime=Join-Path (Split-Path -Parent $PSCommandPath) 'offroader-runtime'
[void][IO.Directory]::CreateDirectory($runtime)
$stateFile=Join-Path $runtime 'server-state.json'
$stopFile=Join-Path $runtime 'stop.request'
$signalExe=Join-Path $GameTrackerRoot 'signaling\target-offroader\release\gametracker-signal.exe'
$cloudExe=(Get-Command cloudflared.exe).Source
$manifestFile=Join-Path $GameTrackerRoot 'signaling\static\offroader.json'
$owner='offroader-shared-world-v1'

function Save-JsonAtomic($path,$value) {
    $temporary=$path+'.tmp'
    [IO.File]::WriteAllText($temporary,($value|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $path -Force
}
function Read-State {
    if(Test-Path -LiteralPath $stateFile){return Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json}
    return $null
}
function Is-Owned($record) {
    if(-not $record){return $false}
    $process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if(-not $process){return $false}
    try {
        return [IO.Path]::GetFullPath($process.Path) -eq [IO.Path]::GetFullPath($record.path) -and
            [math]::Abs(($process.StartTime.ToUniversalTime()-([datetime]$record.started).ToUniversalTime()).TotalMilliseconds) -lt 1.0
    } catch {return $false}
}
function Record-Process($process) {
    $newId=$process.Id
    for($attempt=0;$attempt -lt 20;$attempt++) {
        $process=Get-Process -Id $newId -ErrorAction Stop
        if($process.Path){break}
        Start-Sleep -Milliseconds 50
    }
    if(-not $process.Path){throw "Cannot verify newly launched process $newId"}
    return @{pid=$process.Id;path=$process.Path;started=$process.StartTime.ToUniversalTime().ToString('o')}
}
function Stop-Owned($record) {
    if(Is-Owned $record){Stop-Process -Id $record.pid -ErrorAction SilentlyContinue}
}

$existing=Read-State
if($Action -eq 'Status') {
    if($existing){
        # State survives a PC restart; a saved online label is not live health.
        $running=(Is-Owned $existing.supervisor)
        $serverRunning=(Is-Owned $existing.server)
        $tunnelRunning=(Is-Owned $existing.tunnel)
        $existing|Add-Member -NotePropertyName supervisor_running -NotePropertyValue $running -Force
        $existing|Add-Member -NotePropertyName server_running -NotePropertyValue $serverRunning -Force
        $existing|Add-Member -NotePropertyName tunnel_running -NotePropertyValue $tunnelRunning -Force
        if(-not $running){$existing.state='stopped'}
        elseif(-not $serverRunning -or -not $tunnelRunning){$existing.state='recovering'}
        $existing|ConvertTo-Json -Depth 8
    }else{'{"state":"stopped"}'}
    exit
}
if($Action -eq 'Stop') {
    [IO.File]::WriteAllText($stopFile,'stop')
    if($existing -and $existing.owner -eq $owner){Stop-Owned $existing.tunnel;Stop-Owned $existing.server;Stop-Owned $existing.supervisor}
    Save-JsonAtomic $stateFile @{owner=$owner;state='stopped'}
    exit
}
if($Action -eq 'Start') {
    if($existing -and $existing.owner -eq $owner -and (Is-Owned $existing.supervisor)) {
        $existing|ConvertTo-Json -Depth 8;exit
    }
    if(Test-Path -LiteralPath $stopFile){Remove-Item -LiteralPath $stopFile}
    $pwsh=(Get-Process -Id $PID).Path
    $arguments=@('-NoProfile','-File',('"'+$PSCommandPath+'"'),'-Action','Run','-GameTrackerRoot',('"'+$GameTrackerRoot+'"'),'-Port',$Port)
    $supervisor=Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'supervisor.log') -RedirectStandardError (Join-Path $runtime 'supervisor.error.log')
    @{owner=$owner;supervisor=Record-Process $supervisor;state='starting'}|ConvertTo-Json -Depth 5
    exit
}
if(-not (Test-Path -LiteralPath $signalExe)){throw 'Build signaling/target-offroader release first.'}
if($existing -and $existing.owner -eq $owner -and (Is-Owned $existing.supervisor) -and $existing.supervisor.pid -ne $PID){throw 'Owned supervisor is already running.'}
if(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue){throw "Port $Port is already owned by another listener; no process was stopped."}
$supervisorRecord=Record-Process (Get-Process -Id $PID)
$serviceRecord=$null;$tunnelRecord=$null
try {
    while(-not (Test-Path -LiteralPath $stopFile)) {
        if(-not (Is-Owned $serviceRecord)) {
            $env:PORT=[string]$Port
            $service=Start-Process -FilePath $signalExe -ArgumentList '--offroader-only' -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'server.log') -RedirectStandardError (Join-Path $runtime 'server.error.log')
            $serviceRecord=Record-Process $service
        }
        if(-not (Is-Owned $tunnelRecord)) {
            $tunnelLog=Join-Path $runtime 'tunnel.log'
            # This is an isolated quick tunnel. Do not inherit credentials from
            # the unrelated named discovery tunnel or expose them in its logs.
            $savedTunnelToken=[Environment]::GetEnvironmentVariable('CLOUDFLARED_TUNNEL_TOKEN','Process')
            try {
                [Environment]::SetEnvironmentVariable('CLOUDFLARED_TUNNEL_TOKEN',$null,'Process')
                $tunnel=Start-Process -FilePath $cloudExe -ArgumentList @('tunnel','--url',"http://127.0.0.1:$Port",'--no-autoupdate') -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'tunnel.stdout.log') -RedirectStandardError $tunnelLog
            } finally {
                [Environment]::SetEnvironmentVariable('CLOUDFLARED_TUNNEL_TOKEN',$savedTunnelToken,'Process')
            }
            $tunnelRecord=Record-Process $tunnel
            Save-JsonAtomic $stateFile @{owner=$owner;state='connecting';supervisor=$supervisorRecord;server=$serviceRecord;tunnel=$tunnelRecord;port=$Port}
            $public=''
            for($attempt=0;$attempt -lt 90;$attempt++) {
                if(Test-Path -LiteralPath $stopFile){break}
                if(-not (Is-Owned $tunnelRecord)){break}
                if(Test-Path -LiteralPath $tunnelLog) {
                    $logText=Get-Content -LiteralPath $tunnelLog -Raw -ErrorAction SilentlyContinue
                    if($logText) {
                        $match=[regex]::Match($logText,'https://[a-z0-9-]+\.trycloudflare\.com')
                        if($match.Success){$public=$match.Value;break}
                    }
                }
                Start-Sleep -Seconds 1
            }
            if($public) {
                $healthy=$false
                for($attempt=0;$attempt -lt 12;$attempt++) {
                    try {
                        $health=Invoke-RestMethod -Uri ($public+'/offroader/health') -TimeoutSec 5
                        if($health.service -eq 'offroader' -and $health.protocol -eq 2){$healthy=$true;break}
                    } catch {}
                    Start-Sleep -Seconds 2
                }
                if($healthy) {
                    $endpoint=$public.Replace('https://','wss://')+'/offroader/ws'
                    # The old discovery process serves this file dynamically.
                    # No restart, tunnel credential or existing session is touched.
                    if(Test-Path -LiteralPath $manifestFile) {
                        $prior=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json
                        if($prior.owner -ne $owner){throw 'Refusing to replace another owner''s discovery manifest.'}
                    }
                    Save-JsonAtomic $manifestFile @{owner=$owner;protocol=2;endpoint=$endpoint;transport='wss';capabilities=@($health.capabilities);generation=[guid]::NewGuid().ToString();updated_utc=[datetime]::UtcNow.ToString('o');temporary_transport=$true}
                    Save-JsonAtomic $stateFile @{owner=$owner;state='online';supervisor=$supervisorRecord;server=$serviceRecord;tunnel=$tunnelRecord;port=$Port;endpoint=$endpoint;discovery='https://discovery.chilloutgamestudio.com/offroader.json'}
                } else {Stop-Owned $tunnelRecord;$tunnelRecord=$null}
            } else {Stop-Owned $tunnelRecord;$tunnelRecord=$null}
        }
        Start-Sleep -Seconds 4
    }
} finally {
    Stop-Owned $tunnelRecord;Stop-Owned $serviceRecord
    Save-JsonAtomic $stateFile @{owner=$owner;state='stopped';server=$serviceRecord;tunnel=$tunnelRecord;supervisor=$supervisorRecord}
}
