<#
Prepare a reviewed Vite static build for this checkout's existing discovery server.
Dry-run is the default. -Deploy requires a new backup directory. No process,
service, session, database, runtime file or existing hashed asset is removed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceDirectory,
  [string]$DestinationDirectory,
  [string]$BackupDirectory,
  [switch]$Deploy
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2
if(-not $DestinationDirectory){$DestinationDirectory=Join-Path $PSScriptRoot '../../signaling/static'}
$repoRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path.TrimEnd('\','/')
function Full([string]$path){[System.IO.Path]::GetFullPath($path).TrimEnd('\','/')}
function Under([string]$path,[string]$root){$path.StartsWith($root+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)}
function WorkspacePath([string]$path){$full=Full $path;if(-not(Under $full $repoRoot)){throw "Path is outside this workspace: $full"};$full}
function Hash([string]$path){if(Test-Path -LiteralPath $path -PathType Leaf){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}else{$null}}
function CheckParents([string]$path){
  $cursor=$path
  while(Under $cursor $repoRoot){
    if(Test-Path -LiteralPath $cursor){if(((Get-Item -LiteralPath $cursor -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw "Reparse point in target ancestry: $cursor"}}
    $cursor=Split-Path -Parent $cursor
  }
}
$source=WorkspacePath (Resolve-Path -LiteralPath $SourceDirectory).Path
$destination=WorkspacePath (Resolve-Path -LiteralPath $DestinationDirectory).Path
if($source -eq $destination -or (Under $source $destination) -or (Under $destination $source)){throw 'Source and destination must be separate, non-nested directories.'}
foreach($directory in @($source,$destination)){if(-not(Test-Path -LiteralPath $directory -PathType Container)){throw "Not a directory: $directory"}}
foreach($name in @('companion.html','quest.html','share.html')){if(-not(Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)){throw "Missing entry point: $name"}}
foreach($directory in @($source,$destination)){
  CheckParents $directory
  foreach($entry in @(Get-Item -LiteralPath $directory)+@(Get-ChildItem -LiteralPath $directory -Recurse -Force)){
    if(($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw "Directory contains a reparse point: $($entry.FullName)"}
  }
}
$files=@(Get-ChildItem -LiteralPath $source -Recurse -File -Force | Sort-Object FullName)
$manifest=@()
foreach($file in $files){
  $relative=$file.FullName.Substring($source.Length).TrimStart('\','/')
  if($relative -ieq 'offroader.json'){throw 'Build must not contain the live Offroader runtime file.'}
  $target=Full (Join-Path $destination $relative)
  if(-not(Under $target $destination)){throw "Escaping target: $target"}
  # Hashed assets are immutable. Old browser sessions may still load them.
  $before=Hash $target;$after=Hash $file.FullName
  if($relative -match '^assets[\\/]' -and $before -and $before -ne $after){throw "Existing hashed asset differs: $relative"}
  $manifest+= [pscustomobject]@{path=$relative;source=$file.FullName;target=$target;before=$before;after=$after;entry=($file.Extension -ieq '.html');changed=($before -ne $after)}
}
foreach($name in @('companion.html','quest.html','share.html')){
  $html=[System.IO.File]::ReadAllText((Join-Path $source $name))
  foreach($match in [regex]::Matches($html,'(?i)(?:src|href)\s*=\s*["'']([^"'']+)["'']')){
    $reference=$match.Groups[1].Value
    if($reference -match '^(?:https?:|data:|#|//)'){continue}
    $relative=([Uri]::UnescapeDataString(($reference -split '[?#]',2)[0])).TrimStart('/')
    if(-not $relative){continue}
    $referenced=Full (Join-Path $source $relative)
    if(-not(Under $referenced $source) -or -not(Test-Path -LiteralPath $referenced -PathType Leaf)){throw "Missing or escaping static reference in ${name}: $reference"}
  }
}
$runtime=Join-Path $destination 'offroader.json';$runtimeHash=Hash $runtime
$backup=$null
if($Deploy){
  if(-not $BackupDirectory){throw '-Deploy requires a fresh -BackupDirectory.'}
  $backup=WorkspacePath $BackupDirectory
  CheckParents $backup
  if($backup -eq $source -or $backup -eq $destination -or (Under $backup $source) -or (Under $backup $destination) -or (Under $source $backup) -or (Under $destination $backup)){throw 'Backup must be separate from source and destination.'}
  if(Test-Path -LiteralPath $backup){throw "Backup already exists: $backup"}
  New-Item -ItemType Directory -Path $backup | Out-Null
  # Back up every existing file that this reviewed build will replace.
  foreach($item in $manifest | Where-Object {$_.changed -and $_.before}){
    $saved=Join-Path $backup $item.path
    New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
    Copy-Item -LiteralPath $item.target -Destination $saved
  }
  # New dependencies become available first. Entry files switch individually by
  # same-volume atomic replacement only after all their dependencies are present.
  foreach($item in $manifest | Where-Object changed | Sort-Object entry,path){
    $parent=Split-Path -Parent $item.target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary=Join-Path $parent ('.reviewed-web-'+[guid]::NewGuid().ToString('N')+'.tmp')
    try{
      Copy-Item -LiteralPath $item.source -Destination $temporary
      if((Hash $temporary) -ne $item.after){throw "Copy verification failed: $($item.path)"}
      if(Test-Path -LiteralPath $item.target){[System.IO.File]::Replace($temporary,$item.target,[System.Management.Automation.Language.NullString]::Value)}else{[System.IO.File]::Move($temporary,$item.target)}
    }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
  }
  foreach($item in $manifest){if((Hash $item.target) -ne $item.after){throw "Deployment hash mismatch: $($item.path)"}}
  if((Hash $runtime) -ne $runtimeHash){throw 'Offroader runtime file changed during deployment.'}
}
$report=[pscustomobject]@{utc=[DateTime]::UtcNow.ToString('o');deployed=[bool]$Deploy;source=$source;destination=$destination;backup=$backup;runtimeSha256=$runtimeHash;files=@($manifest | Select-Object path,before,after,entry,changed)}
$json=$report | ConvertTo-Json -Depth 8
if($Deploy){[System.IO.File]::WriteAllText((Join-Path $backup 'deployment-manifest.json'),$json,(New-Object System.Text.UTF8Encoding $false))}
$json
