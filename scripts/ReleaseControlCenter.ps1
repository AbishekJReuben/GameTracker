<#
.SYNOPSIS
  GameTracker Release Control Center — bump, tag, and push to personal for CI.

.DESCRIPTION
  Small WPF dashboard (ChilloutDashboardKit) for the release loop:

    bump version → commit → tag vX.Y.Z → push personal → GitHub Actions

  Personal remote = AbishekJReuben/GameTracker (where CI + Releases live).
  Origin = ChilloutGameStudio/GameTracker (studio mirror — do NOT use -Push on
  bump-version.ps1; that still targets origin).

.NOTES
  powershell -NoProfile -ExecutionPolicy Bypass -Sta -File .\scripts\ReleaseControlCenter.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ReleaseGuiConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@ -ErrorAction SilentlyContinue
  $h = [ReleaseGuiConsole]::GetConsoleWindow()
  if ($h -ne [IntPtr]::Zero) { [ReleaseGuiConsole]::ShowWindow($h, 0) | Out-Null }
} catch {}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml | Out-Null
. (Join-Path $PSScriptRoot 'ChilloutDashboardKit.ps1')
$t = $global:ChilloutTheme

$script:RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:ShipScript = Join-Path $script:RepoRoot 'scripts\Ship-Release.ps1'
$script:BumpScript = Join-Path $script:RepoRoot 'scripts\bump-version.ps1'
$script:Busy       = $false
$script:CiUrl      = 'https://github.com/AbishekJReuben/GameTracker/actions'
$script:PersonalUrl = 'https://github.com/AbishekJReuben/GameTracker'

function Get-PkgVersion {
  $raw = [System.IO.File]::ReadAllText((Join-Path $script:RepoRoot 'package.json'))
  if ($raw -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
  return '?'
}

function Get-NextPatch([string]$ver) {
  $parts = $ver.Split('.')
  if ($parts.Count -lt 3) { return $ver }
  $patch = 0
  [void][int]::TryParse($parts[2], [ref]$patch)
  return ('{0}.{1}.{2}' -f $parts[0], $parts[1], ($patch + 1))
}

function Get-GitLine([string]$args) {
  Push-Location $script:RepoRoot
  try {
    $out = & git @($args.Split(' ')) 2>&1 | Out-String
    return ($out.Trim())
  } finally { Pop-Location }
}

$xamlStr = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:shell="clr-namespace:System.Windows.Shell;assembly=PresentationFramework"
        Title="GameTracker Release" Width="980" Height="720"
        MinWidth="820" MinHeight="600" WindowStartupLocation="CenterScreen"
        WindowStyle="None" ResizeMode="CanResize"
        Background="$($t.Bg)" FontFamily="Segoe UI" UseLayoutRounding="True">
  <shell:WindowChrome.WindowChrome>
    <shell:WindowChrome CaptionHeight="34" CornerRadius="0" GlassFrameThickness="0" ResizeBorderThickness="6" UseAeroCaptionButtons="False"/>
  </shell:WindowChrome.WindowChrome>
  <Window.Resources>
$(Get-CgResourceXaml)
  </Window.Resources>
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="34"/><RowDefinition Height="*"/>
    </Grid.RowDefinitions>

    <Border Grid.Row="0" Background="$($t.Bg2)">
      <Grid>
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center" Margin="12,0,0,0">
          <Ellipse Width="9" Height="9" Fill="$($t.Accent2)" Margin="0,0,9,0"/>
          <TextBlock Text="RELEASE" Foreground="$($t.Text)" FontFamily="Cascadia Mono, Consolas" FontWeight="Bold" FontSize="12.5"/>
          <TextBlock Text=" // bump · tag · personal CI" Foreground="$($t.Dim)" FontFamily="Cascadia Mono, Consolas" FontSize="12.5"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" shell:WindowChrome.IsHitTestVisibleInChrome="True">
          <Button x:Name="BtnWinMin" Content="&#x2013;" Style="{StaticResource Caption}"/>
          <Button x:Name="BtnWinClose" Content="&#x2715;" Style="{StaticResource CaptionClose}"/>
        </StackPanel>
      </Grid>
    </Border>

    <Grid Grid.Row="1" Margin="16">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="1.15*"/><ColumnDefinition Width="16"/><ColumnDefinition Width="0.85*"/>
      </Grid.ColumnDefinitions>

      <!-- LEFT: what / why -->
      <ScrollViewer Grid.Column="0" VerticalScrollBarVisibility="Auto">
        <StackPanel>
          <Border Background="{StaticResource Panel}" BorderBrush="{StaticResource Edge}" BorderThickness="1" CornerRadius="10" Padding="16" Margin="0,0,0,12">
            <StackPanel>
              <TextBlock Text="// WHAT THIS DOES" Foreground="$($t.Accent)" FontFamily="Cascadia Mono, Consolas" FontSize="11" Margin="0,0,0,10"/>
              <TextBlock TextWrapping="Wrap" Foreground="$($t.Text)" FontSize="13" LineHeight="20"
                Text="Ships a new GameTracker version to GitHub so Actions can build the Android APK first, then the Windows installer. Phone updates and desktop silent-updates both read assets from that Release."/>
            </StackPanel>
          </Border>

          <Border Background="{StaticResource Panel}" BorderBrush="{StaticResource Edge}" BorderThickness="1" CornerRadius="10" Padding="16" Margin="0,0,0,12">
            <StackPanel>
              <TextBlock Text="// EACH STEP" Foreground="$($t.Accent)" FontFamily="Cascadia Mono, Consolas" FontSize="11" Margin="0,0,0,10"/>
              <TextBlock TextWrapping="Wrap" Foreground="$($t.Sub)" FontSize="12.5" LineHeight="19" Margin="0,0,0,6"
                Text="1. Bump — rewrite the version in package.json, both tauri.conf.json files, and both Cargo.toml/lock files (desktop + companion must match)."/>
              <TextBlock TextWrapping="Wrap" Foreground="$($t.Sub)" FontSize="12.5" LineHeight="19" Margin="0,0,0,6"
                Text="2. Commit — record those file edits on main so the tag points at a real snapshot."/>
              <TextBlock TextWrapping="Wrap" Foreground="$($t.Sub)" FontSize="12.5" LineHeight="19" Margin="0,0,0,6"
                Text="3. Tag vX.Y.Z — annotated git tag. The Release workflow only starts on v* tags."/>
              <TextBlock TextWrapping="Wrap" Foreground="$($t.Sub)" FontSize="12.5" LineHeight="19" Margin="0,0,0,6"
                Text="4. Push personal — send commit + tag to AbishekJReuben/GameTracker (CI secrets + Releases live here)."/>
              <TextBlock TextWrapping="Wrap" Foreground="$($t.Sub)" FontSize="12.5" LineHeight="19"
                Text="5. CI order — create-release → android APK → desktop NSIS. APK finishes first so you can test the phone build quickly."/>
            </StackPanel>
          </Border>

          <Border Background="{StaticResource Panel}" BorderBrush="{StaticResource Edge}" BorderThickness="1" CornerRadius="10" Padding="16">
            <StackPanel>
              <TextBlock Text="// REMOTES" Foreground="$($t.Accent)" FontFamily="Cascadia Mono, Consolas" FontSize="11" Margin="0,0,0,10"/>
              <TextBlock x:Name="TxtRemotes" TextWrapping="Wrap" Foreground="$($t.Sub)" FontFamily="Cascadia Mono, Consolas" FontSize="12" LineHeight="18"/>
            </StackPanel>
          </Border>
        </StackPanel>
      </ScrollViewer>

      <!-- RIGHT: controls -->
      <StackPanel Grid.Column="2">
        <Border Background="{StaticResource Card}" BorderBrush="{StaticResource Edge}" BorderThickness="1" CornerRadius="10" Padding="16" Margin="0,0,0,12">
          <StackPanel>
            <TextBlock Text="// STATUS" Foreground="$($t.Accent)" FontFamily="Cascadia Mono, Consolas" FontSize="11" Margin="0,0,0,10"/>
            <TextBlock Text="Current version" Foreground="$($t.Dim)" FontSize="11"/>
            <TextBlock x:Name="TxtCurrent" Text="…" Foreground="$($t.Accent2)" FontFamily="Cascadia Mono, Consolas" FontSize="28" FontWeight="Bold" Margin="0,2,0,12"/>
            <TextBlock Text="Branch / HEAD" Foreground="$($t.Dim)" FontSize="11"/>
            <TextBlock x:Name="TxtBranch" Text="…" Foreground="$($t.Text)" FontFamily="Cascadia Mono, Consolas" FontSize="12" TextWrapping="Wrap" Margin="0,2,0,0"/>
          </StackPanel>
        </Border>

        <Border Background="{StaticResource Card}" BorderBrush="{StaticResource Edge}" BorderThickness="1" CornerRadius="10" Padding="16" Margin="0,0,0,12">
          <StackPanel>
            <TextBlock Text="// SHIP" Foreground="$($t.Accent)" FontFamily="Cascadia Mono, Consolas" FontSize="11" Margin="0,0,0,10"/>
            <TextBlock Text="New version" Foreground="$($t.Dim)" FontSize="11" Margin="0,0,0,4"/>
            <TextBox x:Name="TxtVersion" Height="34" Padding="8,6" FontFamily="Cascadia Mono, Consolas" FontSize="14"
                     Background="$($t.LogBg)" Foreground="$($t.Text)" BorderBrush="$($t.Edge)" CaretBrush="$($t.Accent)"/>
            <Button x:Name="BtnShip" Content="Ship to personal (bump · tag · push)" Margin="0,12,0,0" Height="40" Style="{StaticResource Primary}"/>
            <Button x:Name="BtnDry" Content="Dry-run (print steps only)" Margin="0,8,0,0" Height="34" Style="{StaticResource Ghost}"/>
            <Button x:Name="BtnCi" Content="Open GitHub Actions" Margin="0,8,0,0" Height="34" Style="{StaticResource Ghost}"/>
            <Button x:Name="BtnRefresh" Content="Refresh status" Margin="0,8,0,0" Height="34" Style="{StaticResource Ghost}"/>
          </StackPanel>
        </Border>

        <Border Background="{StaticResource LogBg}" BorderBrush="{StaticResource Edge}" BorderThickness="1" CornerRadius="10" Padding="12" MinHeight="180">
          <DockPanel>
            <TextBlock DockPanel.Dock="Top" Text="// LOG" Foreground="$($t.Accent)" FontFamily="Cascadia Mono, Consolas" FontSize="11" Margin="0,0,0,8"/>
            <ScrollViewer VerticalScrollBarVisibility="Auto">
              <TextBlock x:Name="TxtLog" TextWrapping="Wrap" FontFamily="Cascadia Mono, Consolas" FontSize="11.5" Foreground="$($t.Sub)" LineHeight="17"/>
            </ScrollViewer>
          </DockPanel>
        </Border>
      </StackPanel>
    </Grid>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xamlStr)
$window = [Windows.Markup.XamlReader]::Load($reader)

$TxtCurrent = $window.FindName('TxtCurrent')
$TxtBranch  = $window.FindName('TxtBranch')
$TxtVersion = $window.FindName('TxtVersion')
$TxtRemotes = $window.FindName('TxtRemotes')
$TxtLog     = $window.FindName('TxtLog')
$BtnShip    = $window.FindName('BtnShip')
$BtnDry     = $window.FindName('BtnDry')
$BtnCi      = $window.FindName('BtnCi')
$BtnRefresh = $window.FindName('BtnRefresh')
$BtnWinMin  = $window.FindName('BtnWinMin')
$BtnWinClose= $window.FindName('BtnWinClose')

function Write-GuiLog([string]$line) {
  $stamp = (Get-Date).ToString('HH:mm:ss')
  $TxtLog.Text = ("[{0}] {1}`n{2}" -f $stamp, $line, $TxtLog.Text)
}

function Update-Status {
  $cur = Get-PkgVersion
  $TxtCurrent.Text = "v$cur"
  $TxtVersion.Text = (Get-NextPatch $cur)
  $branch = Get-GitLine 'rev-parse --abbrev-ref HEAD'
  $sha = Get-GitLine 'rev-parse --short HEAD'
  $ahead = Get-GitLine 'status -sb'
  $TxtBranch.Text = "$branch @ $sha`n$ahead"
  $r = Get-GitLine 'remote -v'
  $TxtRemotes.Text = $r
}

function Invoke-Ship([switch]$DryRun) {
  if ($script:Busy) { return }
  $verRaw = $TxtVersion.Text
  if ($null -eq $verRaw) { $verRaw = '' }
  $ver = $verRaw.Trim().TrimStart('v', 'V')
  if ($ver -notmatch '^[0-9]+\.[0-9]+\.[0-9]+') {
    [System.Windows.MessageBox]::Show("Enter a semver like 3.9.7", 'Release', 'OK', 'Warning') | Out-Null
    return
  }
  $confirm = if ($DryRun) { 'Yes' } else {
    [System.Windows.MessageBox]::Show(
      "Ship v$ver to personal?`n`nThis will bump files, commit, tag v$ver, and push to personal (starts CI).",
      'Confirm release', 'YesNo', 'Question')
  }
  if ($confirm -ne 'Yes') { return }

  $script:Busy = $true
  $BtnShip.IsEnabled = $false
  $BtnDry.IsEnabled = $false
  Write-GuiLog $(if ($DryRun) { "Dry-run v$ver…" } else { "Shipping v$ver…" })

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $args = "-NoProfile -ExecutionPolicy Bypass -File `"$($script:ShipScript)`" $ver -Remote personal"
  if ($DryRun) { $args += ' -DryRun' }
  $psi.Arguments = $args
  $psi.WorkingDirectory = $script:RepoRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()

  foreach ($line in ($stdout + "`n" + $stderr) -split "`r?`n") {
    if ($line.Trim()) { Write-GuiLog $line.Trim() }
  }

  if ($p.ExitCode -eq 0) {
    Write-GuiLog "Done. Open Actions to watch APK → desktop."
    if (-not $DryRun) { Start-Process $script:CiUrl }
  } else {
    Write-GuiLog "FAILED (exit $($p.ExitCode))"
    [System.Windows.MessageBox]::Show("Ship failed — see log.", 'Release', 'OK', 'Error') | Out-Null
  }

  Update-Status
  $script:Busy = $false
  $BtnShip.IsEnabled = $true
  $BtnDry.IsEnabled = $true
}

$BtnWinMin.Add_Click({ $window.WindowState = 'Minimized' })
$BtnWinClose.Add_Click({ $window.Close() })
$BtnRefresh.Add_Click({ Update-Status; Write-GuiLog 'Status refreshed.' })
$BtnCi.Add_Click({ Start-Process $script:CiUrl })
$BtnDry.Add_Click({ Invoke-Ship -DryRun })
$BtnShip.Add_Click({ Invoke-Ship })

Update-Status
Write-GuiLog 'Ready. Enter a version and Ship to personal.'
[void]$window.ShowDialog()
