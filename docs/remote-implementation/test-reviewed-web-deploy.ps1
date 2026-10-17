[CmdletBinding()]param()
$ErrorActionPreference='Stop'
$utf8=New-Object System.Text.UTF8Encoding $false
$fixture=Join-Path $PSScriptRoot ('evidence/web-deploy-selftest-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$source=Join-Path $fixture 'source';$destination=Join-Path $fixture 'destination';$backup=Join-Path $fixture 'rollback'
$helper=Join-Path $PSScriptRoot 'deploy-reviewed-web.ps1'
New-Item -ItemType Directory -Path (Join-Path $source 'assets'),(Join-Path $destination 'assets') | Out-Null
function WriteFixture([string]$path,[string]$value){[System.IO.File]::WriteAllText($path,$value,$utf8)}
$checks=0
function Assert([bool]$condition,[string]$message){if(-not $condition){throw $message};$script:checks++}
function Reject([scriptblock]$action,[string]$message){$rejected=$false;try{& $action | Out-Null}catch{$rejected=$true};Assert $rejected $message}
$html='<script type="module" src="/assets/new-abc123.js"></script>'
WriteFixture (Join-Path $source 'assets/new-abc123.js') 'console.log("reviewed fixture");'
WriteFixture (Join-Path $destination 'assets/old-def456.js') 'console.log("old session fixture");'
WriteFixture (Join-Path $destination 'offroader.json') '{"fixture":"preserve runtime"}'
WriteFixture (Join-Path $destination 'unrelated-runtime.json') '{"fixture":"preserve unrelated file"}'
foreach($name in @('companion.html','quest.html','share.html')){WriteFixture (Join-Path $source $name) $html;WriteFixture (Join-Path $destination $name) 'old entry fixture'}
$runtimeBefore=(Get-FileHash -LiteralPath (Join-Path $destination 'offroader.json')).Hash
$dry=(& $helper -SourceDirectory $source -DestinationDirectory $destination | ConvertFrom-Json)
Assert (-not $dry.deployed) 'Default invocation deployed.'
Assert (-not(Test-Path -LiteralPath $backup)) 'Dry run created rollback files.'
Assert (-not(Test-Path -LiteralPath (Join-Path $destination 'assets/new-abc123.js'))) 'Dry run copied an asset.'
Assert ([System.IO.File]::ReadAllText((Join-Path $destination 'companion.html')) -eq 'old entry fixture') 'Dry run changed an entry.'
WriteFixture (Join-Path $source 'share.html') '<script src="/assets/missing.js"></script>'
Reject {& $helper -SourceDirectory $source -DestinationDirectory $destination -BackupDirectory $backup -Deploy} 'Missing reference was accepted.'
Assert (-not(Test-Path -LiteralPath $backup)) 'Rejected missing reference created rollback files.'
WriteFixture (Join-Path $source 'share.html') $html
WriteFixture (Join-Path $source 'offroader.json') '{"fixture":"must not deploy"}'
Reject {& $helper -SourceDirectory $source -DestinationDirectory $destination} 'Offroader runtime replacement was accepted.'
# Delete only this explicitly created individual fixture file.
Remove-Item -LiteralPath (Join-Path $source 'offroader.json')
Reject {& $helper -SourceDirectory $source -DestinationDirectory $source} 'Overlapping directories were accepted.'
Reject {& $helper -SourceDirectory $source -DestinationDirectory $destination -Deploy} 'Deployment without rollback directory was accepted.'
$deployed=(& $helper -SourceDirectory $source -DestinationDirectory $destination -BackupDirectory $backup -Deploy | ConvertFrom-Json)
Assert $deployed.deployed 'Explicit deployment was not recorded.'
Assert (Test-Path -LiteralPath (Join-Path $destination 'assets/old-def456.js')) 'Old hashed asset was removed.'
Assert (Test-Path -LiteralPath (Join-Path $destination 'unrelated-runtime.json')) 'Unrelated runtime file was removed.'
Assert (((Get-FileHash -LiteralPath (Join-Path $destination 'offroader.json')).Hash) -eq $runtimeBefore) 'Runtime contents changed.'
foreach($name in @('companion.html','quest.html','share.html')){
  Assert ([System.IO.File]::ReadAllText((Join-Path $destination $name)) -eq $html) "Entry did not deploy: $name"
  Assert ([System.IO.File]::ReadAllText((Join-Path $backup $name)) -eq 'old entry fixture') "Rollback entry is wrong: $name"
}
Assert (Test-Path -LiteralPath (Join-Path $backup 'deployment-manifest.json')) 'Rollback manifest is missing.'
Reject {& $helper -SourceDirectory $source -DestinationDirectory $destination -BackupDirectory $backup -Deploy} 'Existing backup was overwritten.'
WriteFixture (Join-Path $source 'assets/new-abc123.js') 'different content under the same immutable name'
Reject {& $helper -SourceDirectory $source -DestinationDirectory $destination} 'Immutable asset collision was accepted.'
Assert ([System.IO.File]::ReadAllText((Join-Path $destination 'assets/new-abc123.js')) -eq 'console.log("reviewed fixture");') 'Rejected collision changed a deployed asset.'
$report=[pscustomobject]@{passed=$true;checks=$checks;fixture=$fixture;scope='Disposable directories only. No live static directory, server process, sessions or runtime files were changed.'}
$json=$report | ConvertTo-Json
WriteFixture (Join-Path $fixture 'selftest-result.json') $json
$json
