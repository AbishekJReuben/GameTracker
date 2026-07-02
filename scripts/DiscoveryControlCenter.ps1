<#
.SYNOPSIS
  GameTracker Discovery Control Center - WPF analytics dashboard for Start-DiscoveryPublic.ps1.

.DESCRIPTION
  Supervises the signaling rendezvous server (gametracker-signal on :8080) and optional
  Cloudflare tunnel for discovery.chilloutgamestudio.com. Uses ChilloutDashboardKit.

.NOTES
  powershell -NoProfile -ExecutionPolicy Bypass -Sta -File .\scripts\DiscoveryControlCenter.ps1
#>
[CmdletBinding()]
param(
  [string] $DefaultAppHostname = 'discovery.chilloutgamestudio.com',
  [switch] $NoAutoStart,
  [int] $Port = 8080
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Port = $Port

try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class DiscoveryGuiConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@ -ErrorAction SilentlyContinue
  $h = [DiscoveryGuiConsole]::GetConsoleWindow()
  if ($h -ne [IntPtr]::Zero) { [DiscoveryGuiConsole]::ShowWindow($h, 0) | Out-Null }
} catch {}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml | Out-Null
. (Join-Path $PSScriptRoot 'ChilloutDashboardKit.ps1')
$t = $global:ChilloutTheme

$script:RepoRoot        = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:StartScriptPath = Join-Path $script:RepoRoot 'scripts\Start-DiscoveryPublic.ps1'
$script:LogDir          = Join-Path $script:RepoRoot '.logs'
$script:GuiLogFile      = Join-Path $script:LogDir 'control-center.log'
$script:RunnerProcess   = $null
$script:OutSub          = $null
$script:ErrSub          = $null
$script:CurrentStep     = 'Idle'
$script:StopBusy        = $false
$script:LastPollUtc     = [datetime]::MinValue
$script:LastResult      = $null
$script:Probe           = $null
$script:ProbeRs         = $null
$script:ProbeAsync      = $null
$global:DiscoveryLogQueue = [System.Collections.Concurrent.ConcurrentQueue[object]]::new()
$script:AllLogEntries   = [System.Collections.Generic.List[object]]::new()
$script:DiagAction      = $null

if (-not (Test-Path -LiteralPath $script:LogDir)) { New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null }
if (-not (Test-Path -LiteralPath $script:StartScriptPath)) {
  [System.Windows.MessageBox]::Show("Missing script:`n$script:StartScriptPath", 'Discovery Control Center', 'OK', 'Error') | Out-Null
  return
}

$Palette = @{ Online=$t.Online; Degraded=$t.Degraded; Offline=$t.Offline; Checking=$t.Checking; Idle=$t.Idle; Accent=$t.Accent }

$xamlStr = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:shell="clr-namespace:System.Windows.Shell;assembly=PresentationFramework"
        Title="GameTracker Discovery" Width="1280" Height="880"
        MinWidth="1020" MinHeight="720" WindowStartupLocation="CenterScreen"
        WindowStyle="None" ResizeMode="CanResize"
        Background="$($t.Bg)" FontFamily="Segoe UI" UseLayoutRounding="True">
  <shell:WindowChrome.WindowChrome>
    <shell:WindowChrome CaptionHeight="34" CornerRadius="0" GlassFrameThickness="0" ResizeBorderThickness="6" UseAeroCaptionButtons="False"/>
  </shell:WindowChrome.WindowChrome>
  <Window.Resources>
$(Get-CgResourceXaml)
  </Window.Resources>
  <Grid x:Name="Root">
    <Grid.RowDefinitions>
      <RowDefinition Height="34"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/>
    </Grid.RowDefinitions>
    <Border Grid.Row="0" Background="$($t.Bg2)">
      <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center" Margin="12,0,0,0">
          <Ellipse Width="9" Height="9" Fill="$($t.Accent2)" Margin="0,0,9,0"/>
          <TextBlock Text="DISCOVERY" Foreground="$($t.Text)" FontFamily="Cascadia Mono, Consolas" FontWeight="Bold" FontSize="12.5"/>
          <TextBlock Text=" // SIGNALING" Foreground="$($t.Dim)" FontFamily="Cascadia Mono, Consolas" FontSize="12.5"/>
        </StackPanel>
        <StackPanel Grid.Column="1" Orientation="Horizontal" shell:WindowChrome.IsHitTestVisibleInChrome="True">
          <Button x:Name="BtnWinMin" Content="&#x2013;" Style="{StaticResource Caption}"/>
          <Button x:Name="BtnWinMax" Content="&#x2752;" Style="{StaticResource Caption}"/>
          <Button x:Name="BtnWinClose" Content="&#x2715;" Style="{StaticResource CaptionClose}"/>
        </StackPanel>
      </Grid>
    </Border>
    <Border Grid.Row="1" Background="{StaticResource Panel}" Padding="18,12,16,12" BorderBrush="{StaticResource Edge}" BorderThickness="0,0,0,1">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <StackPanel Grid.Column="0" VerticalAlignment="Center">
          <TextBlock Text="Discovery Control Center" Foreground="{StaticResource Text}" FontSize="17" FontWeight="SemiBold"/>
          <StackPanel Orientation="Horizontal">
            <TextBlock x:Name="TxtStep" Text="Idle" Foreground="{StaticResource SubText}" FontFamily="Cascadia Mono, Consolas" FontSize="11.5"/>
            <TextBlock x:Name="TxtCursor" Text="_" Foreground="$($t.Accent2)" FontFamily="Cascadia Mono, Consolas" FontSize="11.5" Margin="1,0,0,0"/>
          </StackPanel>
        </StackPanel>
        <StackPanel Grid.Column="1" Orientation="Horizontal" HorizontalAlignment="Right" Margin="14,0">
          <Border CornerRadius="9" Background="#0C1822" BorderBrush="{StaticResource Edge}" BorderThickness="1" Padding="9,4" Margin="0,0,7,0">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="svc " FontFamily="Cascadia Mono, Consolas" FontSize="9.5" Foreground="$($t.Dim)"/>
              <TextBlock x:Name="TxtMiniServices" Text="-/-" FontFamily="Cascadia Mono, Consolas" FontSize="12.5" FontWeight="Bold" Foreground="$($t.Accent2)"/>
            </StackPanel>
          </Border>
          <Border CornerRadius="9" Background="#0C1822" BorderBrush="{StaticResource Edge}" BorderThickness="1" Padding="9,4" Margin="0,0,7,0">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="local " FontFamily="Cascadia Mono, Consolas" FontSize="9.5" Foreground="$($t.Dim)"/>
              <TextBlock x:Name="TxtMiniLocalMs" Text="-" FontFamily="Cascadia Mono, Consolas" FontSize="12.5" FontWeight="Bold" Foreground="$($t.Accent)"/>
            </StackPanel>
          </Border>
          <Border CornerRadius="9" Background="#0C1822" BorderBrush="{StaticResource Edge}" BorderThickness="1" Padding="9,4">
            <StackPanel Orientation="Horizontal">
              <TextBlock Text="conn " FontFamily="Cascadia Mono, Consolas" FontSize="9.5" Foreground="$($t.Dim)"/>
              <TextBlock x:Name="TxtMiniConns" Text="0" FontFamily="Cascadia Mono, Consolas" FontSize="12.5" FontWeight="Bold" Foreground="$($t.Amber)"/>
            </StackPanel>
          </Border>
        </StackPanel>
        <StackPanel Grid.Column="2" VerticalAlignment="Center" Margin="0,0,14,0">
          <Border x:Name="HealthPill" CornerRadius="13" Padding="13,5" Background="#13202C" BorderBrush="{StaticResource Edge}" BorderThickness="1">
            <StackPanel Orientation="Horizontal">
              <Ellipse x:Name="HealthDot" Width="10" Height="10" Fill="$($t.Idle)" Margin="0,0,8,0">
                <Ellipse.Effect><DropShadowEffect x:Name="HealthGlow" Color="$($t.Idle)" BlurRadius="10" ShadowDepth="0"/></Ellipse.Effect>
              </Ellipse>
              <TextBlock x:Name="TxtHealth" Text="Initializing..." Foreground="{StaticResource Text}" FontSize="12.5" FontWeight="SemiBold"/>
            </StackPanel>
          </Border>
          <ProgressBar x:Name="ProgOverall" Height="6" Minimum="0" Maximum="100" Value="0" Width="220" Margin="0,8,0,0"/>
        </StackPanel>
        <StackPanel Grid.Column="3" Orientation="Horizontal" VerticalAlignment="Center">
          <Button x:Name="BtnStart" Content="Start Stack" Style="{StaticResource Primary}" Margin="0,0,8,0"/>
          <Button x:Name="BtnStop" Content="Stop" Style="{StaticResource Danger}" Margin="0,0,8,0" IsEnabled="False"/>
          <Button x:Name="BtnRestart" Content="Restart" Style="{StaticResource Ghost}"/>
        </StackPanel>
      </Grid>
    </Border>
    <Grid Grid.Row="2">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="7*" MinWidth="520"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="3*" MinWidth="330"/>
      </Grid.ColumnDefinitions>
      <ScrollViewer Grid.Column="0" VerticalScrollBarVisibility="Auto" Padding="18,10,8,16">
        <StackPanel>
          <TextBlock Text="// ANALYTICS" Foreground="{StaticResource Accent2}" FontFamily="Cascadia Mono, Consolas" FontWeight="SemiBold" FontSize="13" Margin="2,0,0,10"/>
          <TextBlock x:Name="TxtAnalyticsHead" Text="warming up..." Foreground="{StaticResource SubText}" FontSize="11.5" Margin="2,0,0,10"/>
          <StackPanel x:Name="AnalyticsSectionsHost"/>
          <Grid Margin="6,6,6,0">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
            <Border Grid.Column="0" Background="{StaticResource Panel}" CornerRadius="12" Padding="15,13" Margin="0,0,6,12">
              <StackPanel>
                <TextBlock Text="HTTP methods" FontWeight="SemiBold" FontSize="13" Margin="0,0,0,12"/>
                <StackPanel x:Name="MethodsHost"/>
              </StackPanel>
            </Border>
            <Border Grid.Column="1" Background="{StaticResource Panel}" CornerRadius="12" Padding="15,13" Margin="6,0,0,12">
              <StackPanel>
                <TextBlock Text="Status codes" FontWeight="SemiBold" FontSize="13" Margin="0,0,0,12"/>
                <StackPanel x:Name="StatusHost"/>
              </StackPanel>
            </Border>
          </Grid>
          <Border Background="{StaticResource Panel}" CornerRadius="12" Padding="15,13" Margin="6,0,6,12">
            <StackPanel>
              <TextBlock Text="Signaling endpoints" FontWeight="SemiBold" FontSize="13" Margin="0,0,0,10"/>
              <StackPanel x:Name="RoutesHost"/>
            </StackPanel>
          </Border>
          <Border Background="{StaticResource Panel}" CornerRadius="12" Padding="15,13" Margin="6,0,6,14">
            <StackPanel>
              <TextBlock Text="System and stack resources" FontWeight="SemiBold" FontSize="13" Margin="0,0,0,12"/>
              <StackPanel x:Name="ResourcesHost"/>
            </StackPanel>
          </Border>
        </StackPanel>
      </ScrollViewer>
      <GridSplitter Grid.Column="1" Width="6" Background="#1A2230"/>
      <Grid Grid.Column="2" Margin="6,10,14,12">
        <Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="240"/></Grid.RowDefinitions>
        <ScrollViewer Grid.Row="0" VerticalScrollBarVisibility="Auto">
          <StackPanel>
            <Border Background="{StaticResource Panel}" CornerRadius="11" Padding="13,11" Margin="0,0,0,9" BorderBrush="{StaticResource Edge}" BorderThickness="1">
              <StackPanel>
                <TextBlock Text="// CONTROLS" Foreground="{StaticResource Accent2}" FontFamily="Cascadia Mono, Consolas" FontWeight="SemiBold" FontSize="11.5" Margin="0,0,0,10"/>
                <WrapPanel>
                  <CheckBox x:Name="ChkCustomDomain" Content="Custom domain" IsChecked="True"/>
                  <CheckBox x:Name="ChkLocalOnly" Content="Local only"/>
                  <CheckBox x:Name="ChkSkipBuild" Content="Skip build" IsChecked="False"/>
                  <CheckBox x:Name="ChkSkipTunnel" Content="Skip tunnel" IsChecked="True"/>
                  <CheckBox x:Name="ChkAutoStart" Content="Auto-start" IsChecked="True"/>
                </WrapPanel>
                <Grid Margin="0,8,0,10">
                  <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                  <Label Content="Public host" Margin="0,0,8,0"/>
                  <TextBox x:Name="TxtAppHost" Grid.Column="1"/>
                </Grid>
                <WrapPanel>
                  <Button x:Name="BtnRecheck" Content="Re-check" Style="{StaticResource Ghost}"/>
                  <Button x:Name="BtnOpenLocal" Content="Local /health" Style="{StaticResource Ghost}"/>
                  <Button x:Name="BtnOpenPublic" Content="Public URL" Style="{StaticResource Ghost}"/>
                  <Button x:Name="BtnOpenLogs" Content=".logs" Style="{StaticResource Ghost}"/>
                  <Button x:Name="BtnCopyDiag" Content="Copy diag" Style="{StaticResource Ghost}"/>
                </WrapPanel>
              </StackPanel>
            </Border>
            <Border Background="{StaticResource Panel}" CornerRadius="11" Padding="13,11" Margin="0,0,0,9" BorderBrush="{StaticResource Edge}" BorderThickness="1">
              <StackPanel>
                <TextBlock Text="// TROUBLESHOOTING" Foreground="{StaticResource Amber}" FontFamily="Cascadia Mono, Consolas" FontWeight="SemiBold" FontSize="11.5" Margin="0,0,0,8"/>
                <WrapPanel Margin="0,0,0,4">
                  <Button x:Name="BtnCargoBuild" Content="cargo build" Style="{StaticResource Term}"/>
                  <Button x:Name="BtnRestartSignal" Content="Restart :8080" Style="{StaticResource Term}"/>
                  <Button x:Name="BtnStartTunnel" Content="Start tunnel" Style="{StaticResource Term}"/>
                </WrapPanel>
                <WrapPanel Margin="0,0,0,4">
                  <Button x:Name="BtnFreePort" Content="Free :8080" Style="{StaticResource Tool}"/>
                  <Button x:Name="BtnKillTunnel" Content="Kill tunnel" Style="{StaticResource Tool}"/>
                  <Button x:Name="BtnFlushDns" Content="Flush DNS" Style="{StaticResource Tool}"/>
                  <Button x:Name="BtnTestHealth" Content="Test health" Style="{StaticResource Tool}"/>
                  <Button x:Name="BtnCopyCurl" Content="Copy curl" Style="{StaticResource Tool}"/>
                </WrapPanel>
                <WrapPanel>
                  <Button x:Name="BtnSignalLog" Content="Signal log" Style="{StaticResource Ghost}"/>
                  <Button x:Name="BtnRepairLog" Content="Repair log" Style="{StaticResource Ghost}"/>
                  <Button x:Name="BtnOpenRepo" Content="Open repo" Style="{StaticResource Ghost}"/>
                </WrapPanel>
              </StackPanel>
            </Border>
            <Border x:Name="DiagBanner" Visibility="Collapsed" CornerRadius="10" Background="#241410" BorderBrush="#7F3D1D" BorderThickness="1" Padding="14,11" Margin="0,0,0,10">
              <StackPanel>
                <TextBlock x:Name="DiagTitle" Foreground="#FBBF24" FontWeight="SemiBold" TextWrapping="Wrap"/>
                <TextBlock x:Name="DiagFix" Foreground="{StaticResource Text}" FontSize="11.5" Margin="0,5,0,0" TextWrapping="Wrap"/>
                <Button x:Name="BtnDiagAction" Content="Fix" Style="{StaticResource Primary}" HorizontalAlignment="Left" Margin="0,9,0,0" Visibility="Collapsed"/>
              </StackPanel>
            </Border>
            <Border Background="{StaticResource Panel}" CornerRadius="11" Padding="13,11" BorderBrush="{StaticResource Edge}" BorderThickness="1">
              <StackPanel>
                <TextBlock Text="// SERVICES" Foreground="{StaticResource Accent2}" FontFamily="Cascadia Mono, Consolas" FontWeight="SemiBold" FontSize="11.5" Margin="0,0,0,8"/>
                <StackPanel x:Name="CardsPanel"/>
              </StackPanel>
            </Border>
          </StackPanel>
        </ScrollViewer>
        <Border Grid.Row="1" Background="{StaticResource Panel}" CornerRadius="11" Margin="0,9,0,0" BorderBrush="{StaticResource Edge}" BorderThickness="1">
          <Grid Margin="14,12">
            <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/></Grid.RowDefinitions>
            <StackPanel Grid.Row="0" Margin="0,0,0,8">
              <TextBlock x:Name="TxtLogTitle" Text="Activity Log" FontWeight="SemiBold" Margin="0,0,0,8"/>
              <ComboBox x:Name="CmbLogSource" SelectedIndex="0" Margin="0,0,0,6"/>
              <WrapPanel>
                <ComboBox x:Name="CmbFilter" Width="100" SelectedIndex="0" Margin="0,0,6,0">
                  <ComboBoxItem Content="All"/><ComboBoxItem Content="Info"/><ComboBoxItem Content="Warnings"/><ComboBoxItem Content="Errors"/>
                </ComboBox>
                <TextBox x:Name="TxtSearch" Width="110" Margin="0,0,6,6"/>
                <Button x:Name="BtnRefreshSvcLog" Content="Refresh" Style="{StaticResource Ghost}"/>
                <CheckBox x:Name="ChkAutoScroll" Content="Auto-scroll" IsChecked="True"/>
              </WrapPanel>
            </StackPanel>
            <Border Grid.Row="1" Background="{StaticResource LogBg}" CornerRadius="8">
              <ListBox x:Name="LbLogs" Background="Transparent" BorderThickness="0" FontFamily="Cascadia Mono, Consolas" FontSize="11.5"/>
            </Border>
          </Grid>
        </Border>
      </Grid>
    </Grid>
  </Grid>
</Window>
"@
[xml]$xaml = $xamlStr
$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [System.Windows.Markup.XamlReader]::Load($reader)

$script:Ctl = @{}
$script:SuppressLogSourceChange = $false
foreach ($n in @('Root','TxtStep','TxtCursor','BtnWinMin','BtnWinMax','BtnWinClose','TxtMiniServices','TxtMiniLocalMs','TxtMiniConns',
  'HealthDot','HealthGlow','TxtHealth','ProgOverall','BtnStart','BtnStop','BtnRestart','ChkCustomDomain','ChkLocalOnly','ChkSkipBuild',
  'ChkSkipTunnel','ChkAutoStart','TxtAppHost','BtnRecheck','BtnOpenLocal','BtnOpenPublic','BtnOpenLogs','BtnCopyDiag',
  'BtnCargoBuild','BtnRestartSignal','BtnStartTunnel','BtnFreePort','BtnKillTunnel','BtnFlushDns','BtnTestHealth','BtnCopyCurl',
  'BtnSignalLog','BtnRepairLog','BtnOpenRepo','DiagBanner','DiagTitle','DiagFix','BtnDiagAction','CardsPanel',
  'AnalyticsSectionsHost','TxtAnalyticsHead','MethodsHost','StatusHost','RoutesHost','ResourcesHost',
  'CmbLogSource','TxtLogTitle','BtnRefreshSvcLog','CmbFilter','TxtSearch','ChkAutoScroll','LbLogs')) {
  $script:Ctl[$n] = $window.FindName($n)
}
$script:Ctl.TxtAppHost.Text = $DefaultAppHostname
if ($NoAutoStart) { $script:Ctl.ChkAutoStart.IsChecked = $false }

$cardDefs = @(
  @{ Key='runner'; Title='Startup Runner'; Mono='RUN'; Accent='#6366F1' },
  @{ Key='signal'; Title='Signaling Server'; Mono='SIG'; Accent='#3ECF8E' },
  @{ Key='build';  Title='Release Binary'; Mono='BIN'; Accent='#A78BFA' },
  @{ Key='tunnel'; Title='Cloudflare Tunnel'; Mono='CF'; Accent='#F38020' },
  @{ Key='public'; Title='Public Discovery'; Mono='WEB'; Accent='#22D3EE' }
)
$script:Cards = @{}
$script:ServiceLogSources = @{
  runner = @{ Files = @('discovery-start.log'); ActivityKeywords = @('Start-Discovery', '===', 'Discovery') }
  signal = @{ Files = @('discovery-signal.log'); Port = 8080; Url = 'http://localhost:8080/health'; ActivityKeywords = @('listening', '8080', 'signaling') }
  build  = @{ Files = @('discovery-start.log'); ActivityKeywords = @('cargo', 'build', 'gametracker-signal') }
  tunnel = @{ Files = @('cloudflared-discovery.log'); ActivityKeywords = @('cloudflared', 'tunnel') }
  public = @{ Files = @('discovery-host.log'); ActivityKeywords = @('discovery.chilloutgamestudio', 'health', '502') }
  repair = @{ Files = @('repair.log') }
}

# --- logging helpers ---
function Add-LogLine([string]$Text, [string]$Level = 'INFO') {
  $global:DiscoveryLogQueue.Enqueue([pscustomobject]@{ Stamp=(Get-Date -Format 'HH:mm:ss'); Level=$Level; Text=$Text })
}
$logLevelColors = @{ INFO='#C9D4E0'; OK='#34D399'; WARN='#FBBF24'; ERR='#F87171'; STEP='#22D3EE' }
function Test-LogPassesFilter($entry) {
  switch ($script:Ctl.CmbFilter.SelectedIndex) {
    1 { if ($entry.Level -notin @('INFO','OK','STEP')) { return $false } }
    2 { if ($entry.Level -ne 'WARN') { return $false } }
    3 { if ($entry.Level -ne 'ERR') { return $false } }
  }
  $q = $script:Ctl.TxtSearch.Text
  if ($q -and $entry.Text -notmatch [regex]::Escape($q)) { return $false }
  return $true
}
function New-LogListItem($entry) {
  $item = New-Object System.Windows.Controls.ListBoxItem
  $tb = New-Object System.Windows.Controls.TextBlock
  $color = $logLevelColors[$entry.Level]; if (-not $color) { $color = '#C9D4E0' }
  $tb.Inlines.Add((New-Object System.Windows.Documents.Run("$($entry.Stamp)  ") -Property @{ Foreground=(ConvertTo-Brush '#5B6675') }))
  $lvl = New-Object System.Windows.Documents.Run(("{0,-4} " -f $entry.Level))
  $lvl.Foreground = ConvertTo-Brush $color; $lvl.FontWeight = 'SemiBold'
  $tb.Inlines.Add($lvl)
  $tb.Inlines.Add((New-Object System.Windows.Documents.Run($entry.Text) -Property @{ Foreground=(ConvertTo-Brush $color) }))
  $item.Content = $tb
  return $item
}
function Rebuild-LogView {
  $script:Ctl.LbLogs.BeginInit(); $script:Ctl.LbLogs.Items.Clear()
  foreach ($e in $script:AllLogEntries) { if (Test-LogPassesFilter $e) { $script:Ctl.LbLogs.Items.Add((New-LogListItem $e)) | Out-Null } }
  $script:Ctl.LbLogs.EndInit()
  if ($script:Ctl.ChkAutoScroll.IsChecked -and $script:Ctl.LbLogs.Items.Count -gt 0) {
    $script:Ctl.LbLogs.ScrollIntoView($script:Ctl.LbLogs.Items[$script:Ctl.LbLogs.Items.Count - 1])
  }
}
function Show-Diagnosis([string]$Title, [string]$Fix) {
  $script:Ctl.DiagTitle.Text = $Title; $script:Ctl.DiagFix.Text = $Fix; $script:Ctl.DiagBanner.Visibility = 'Visible'
}
function Hide-Diagnosis { $script:Ctl.DiagBanner.Visibility = 'Collapsed' }

# --- service cards ---
function New-ServiceCard($def) {
  $card = New-Object System.Windows.Controls.Border
  $card.CornerRadius = 8; $card.Background = ConvertTo-Brush $t.Card; $card.BorderBrush = ConvertTo-Brush $t.Edge
  $card.BorderThickness = 1; $card.Margin = '0,0,0,6'; $card.Padding = '10,7'; $card.Cursor = 'Hand'; $card.Tag = $def.Key
  $card.Add_PreviewMouseLeftButtonUp({ param($s,$e) try { $e.Handled=$true; Invoke-ServiceLogSelect ([string]$s.Tag) } catch {} })
  $grid = New-Object System.Windows.Controls.Grid
  $grid.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition -Property @{ Width='Auto' }))
  $grid.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition -Property @{ Width='*' }))
  $grid.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition -Property @{ Width='Auto' }))
  $dot = New-Object System.Windows.Shapes.Ellipse; $dot.Width=10; $dot.Height=10; $dot.Fill=ConvertTo-Brush $t.Idle; $dot.Margin='0,0,9,0'
  $glow = New-Object System.Windows.Media.Effects.DropShadowEffect; $glow.ShadowDepth=0; $glow.BlurRadius=12; $dot.Effect=$glow
  [System.Windows.Controls.Grid]::SetColumn($dot,0); $grid.Children.Add($dot)|Out-Null
  $mid = New-Object System.Windows.Controls.StackPanel; [System.Windows.Controls.Grid]::SetColumn($mid,1)
  $title = New-Object System.Windows.Controls.TextBlock; $title.Text=$def.Title; $title.FontWeight='SemiBold'; $title.FontSize=12.5
  $detail = New-Object System.Windows.Controls.TextBlock; $detail.Text='Probing...'; $detail.FontSize=10.5; $detail.Foreground=ConvertTo-Brush $t.Sub
  $extra = New-Object System.Windows.Controls.TextBlock; $extra.Visibility='Collapsed'
  $mid.Children.Add($title)|Out-Null; $mid.Children.Add($detail)|Out-Null; $mid.Children.Add($extra)|Out-Null; $grid.Children.Add($mid)|Out-Null
  $stateTxt = New-Object System.Windows.Controls.TextBlock; $stateTxt.Text='Checking...'; $stateTxt.FontWeight='SemiBold'; $stateTxt.HorizontalAlignment='Right'
  [System.Windows.Controls.Grid]::SetColumn($stateTxt,2); $grid.Children.Add($stateTxt)|Out-Null
  $card.Child = $grid
  return [pscustomobject]@{ Root=$card; Dot=$dot; Glow=$glow; StateText=$stateTxt; DetailText=$detail; ExtraText=$extra; LastState='' }
}
$stateLabels = @{ Checking='Checking...'; Online='Online'; Degraded='Degraded'; Offline='Offline'; Idle='Idle' }
function Set-CardState([string]$Key, [string]$State, [string]$Detail, [string[]]$Extra=@()) {
  if (-not $script:Cards.ContainsKey($Key)) { return }
  $c = $script:Cards[$Key]; $hex = $Palette[$State]; if (-not $hex) { $hex = $Palette.Idle }
  $brush = ConvertTo-Brush $hex; $c.Dot.Fill = $brush; $c.Glow.Color = (ConvertTo-Color $hex)
  $c.StateText.Text = $(if ($stateLabels[$State]) { $stateLabels[$State] } else { $State }); $c.StateText.Foreground = $brush
  $c.DetailText.Text = $Detail
  if ($State -eq 'Checking') { Start-Pulse $c.Dot } else { Stop-Pulse $c.Dot }
  $c.LastState = $State
}
foreach ($def in $cardDefs) {
  $c = New-ServiceCard $def; $script:Cards[$def.Key] = $c; $script:Ctl.CardsPanel.Children.Add($c.Root) | Out-Null
}
$script:Ctl.CmbLogSource.Items.Clear()
$null = $script:Ctl.CmbLogSource.Items.Add((New-Object System.Windows.Controls.ComboBoxItem -Property @{ Content='All activity'; Tag='activity' }))
foreach ($def in $cardDefs) {
  $null = $script:Ctl.CmbLogSource.Items.Add((New-Object System.Windows.Controls.ComboBoxItem -Property @{ Content=$def.Title; Tag=$def.Key }))
}

function Get-LogSourceKey {
  if ($script:Ctl.CmbLogSource.SelectedIndex -le 0) { return 'activity' }
  $item = $script:Ctl.CmbLogSource.SelectedItem
  if ($item -and $item.Tag) { return [string]$item.Tag }
  return 'activity'
}
function Get-ServiceLogContent([string]$Key) {
  $cfg = $script:ServiceLogSources[$Key]; if (-not $cfg) { return '(unknown)' }
  $sb = New-Object System.Text.StringBuilder
  if ($cfg.ContainsKey('Port')) { [void]$sb.AppendLine("Port: $($cfg.Port)"); if ($cfg.ContainsKey('Url')) { [void]$sb.AppendLine("URL: $($cfg.Url)") }; [void]$sb.AppendLine('') }
  if ($cfg.ContainsKey('Files')) {
    foreach ($f in $cfg.Files) {
      $path = Join-Path $script:LogDir $f; [void]$sb.AppendLine("=== $f ===")
      if (Test-Path $path) { [void]$sb.AppendLine((Get-Content $path -Tail 30 -ErrorAction SilentlyContinue) -join [Environment]::NewLine) }
      else { [void]$sb.AppendLine('(not created yet)') }; [void]$sb.AppendLine('')
    }
  }
  return $sb.ToString().TrimEnd()
}
function Invoke-ServiceLogSelect([string]$Key) {
  $script:SuppressLogSourceChange = $true
  try {
    for ($i=0; $i -lt $script:Ctl.CmbLogSource.Items.Count; $i++) {
      if ([string]$script:Ctl.CmbLogSource.Items[$i].Tag -eq $Key) { $script:Ctl.CmbLogSource.SelectedIndex = $i; break }
    }
    if ($Key -eq 'activity') { $script:Ctl.TxtLogTitle.Text = 'Activity Log'; Rebuild-LogView; return }
    $script:Ctl.TxtLogTitle.Text = "$Key log"
    $text = Get-ServiceLogContent $Key
    $script:Ctl.LbLogs.Items.Clear()
    foreach ($line in ($text -split "`r?`n")) {
      if ($line -eq '') { continue }
      $item = New-Object System.Windows.Controls.ListBoxItem
      $tb = New-Object System.Windows.Controls.TextBlock; $tb.Text = $line; $tb.FontFamily = 'Consolas'; $item.Content = $tb
      $script:Ctl.LbLogs.Items.Add($item) | Out-Null
    }
  } finally { $script:SuppressLogSourceChange = $false }
}

# --- analytics tiles ---
$script:Analytics = @{}; $script:MethodRows = @{}; $script:StatusRows = @{}; $script:Res = @{}
$script:SessionStartUtc = [DateTime]::UtcNow; $script:Spark = @{}; $script:ProbeSessionStart = $null
$script:LastProbeTotal = $null; $script:Metrics = $null; $script:MetricsRs = $null; $script:MetricsAsync = $null
$script:LastMetricsUtc = [datetime]::MinValue; $script:LastMetricsStartUtc = [datetime]::MinValue
foreach ($sk in @('localms','publicms','success','conns','sigcpu','sigmem','net','cf')) { $script:Spark[$sk] = [System.Collections.Generic.List[double]]::new() }

function Add-Section([string]$Title, [array]$Defs) {
  $script:Ctl.AnalyticsSectionsHost.Children.Add((New-SectionHeader ("// " + $Title))) | Out-Null
  $wp = New-Object System.Windows.Controls.WrapPanel
  foreach ($d in $Defs) {
    $tile = New-MetricTile $d.Title $d.Accent; Add-Sparkline $tile | Out-Null
    $script:Analytics[$d.Key] = $tile; $wp.Children.Add($tile.Root) | Out-Null
  }
  $script:Ctl.AnalyticsSectionsHost.Children.Add($wp) | Out-Null
}
Add-Section 'SIGNAL HEALTH' @(
  @{ Key='localms'; Title='Local /health'; Accent='#22D3EE' },
  @{ Key='publicms'; Title='Public /health'; Accent='#3DF5A0' },
  @{ Key='success'; Title='Probe success'; Accent='#34D399' },
  @{ Key='conns'; Title=':8080 sessions'; Accent='#F472B6' }
)
Add-Section 'RESOURCES' @(
  @{ Key='sigcpu'; Title='Signal CPU'; Accent='#A78BFA' },
  @{ Key='sigmem'; Title='Signal RAM'; Accent='#38BDF8' },
  @{ Key='net'; Title='Network KB/s'; Accent='#34D399' },
  @{ Key='cf'; Title='cloudflared'; Accent='#F59E0B' }
)
foreach ($md in @(@('GET','#34D399'),@('OPTIONS','#64748B'),@('WS','#E879F9'))) {
  $row = New-BarRow $md[0] $md[1] 64 78; $script:MethodRows[$md[0]] = $row; $script:Ctl.MethodsHost.Children.Add($row.Root)|Out-Null
}
foreach ($sd in @(@('2xx','#34D399'),@('3xx','#38BDF8'),@('4xx','#FBBF24'),@('5xx','#F87171'))) {
  $row = New-BarRow $sd[0] $sd[1] 48 78; $script:StatusRows[$sd[0]] = $row; $script:Ctl.StatusHost.Children.Add($row.Root)|Out-Null
}
foreach ($rk in @(@('sigcpu','Signal CPU','#A78BFA'),@('sigmem','Signal RAM','#38BDF8'),@('net','Network','#34D399'),@('conns','TCP :8080','#F472B6'),@('cf','cloudflared','#F59E0B'))) {
  $line = New-ResLine $rk[2]; $line.Key.Text = $rk[1]; $script:Res[$rk[0]] = $line; $script:Ctl.ResourcesHost.Children.Add($line.Root)|Out-Null
}
function Push-Spark([string]$key, [double]$v) {
  if (-not $script:Spark.ContainsKey($key)) { $script:Spark[$key] = [System.Collections.Generic.List[double]]::new() }
  $lst = $script:Spark[$key]; $lst.Add($v)|Out-Null; if ($lst.Count -gt 48) { $lst.RemoveAt(0) }
}

$script:MetricsScript = {
  $m = @{ SigCpu=0.0; SigMemMB=0; SigPid=0; ActiveConns=0; NetUpKB=0.0; NetDownKB=0.0; CloudflaredCount=0 }
  try {
    $listen = @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($listen.Count -gt 0) {
      $m.ActiveConns = @(Get-NetTCPConnection -LocalPort 8080 -State Established -ErrorAction SilentlyContinue).Count
      $proc = Get-Process -Id $listen[0].OwningProcess -ErrorAction SilentlyContinue
      if ($proc) {
        $m.SigPid = $proc.Id; $m.SigMemMB = [int]([math]::Round($proc.WorkingSet64/1MB,0))
        $perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=$($proc.Id)" -ErrorAction SilentlyContinue)
        if ($perf.Count -gt 0) { $m.SigCpu = [double]$perf[0].PercentProcessorTime }
      }
    }
  } catch {}
  try {
    $m.CloudflaredCount = @(Get-Process -Name cloudflared -ErrorAction SilentlyContinue).Count
    $ni = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo|Pseudo' })
    $up=0.0; $down=0.0; foreach ($n in $ni) { $up += [double]$n.BytesSentPersec; $down += [double]$n.BytesReceivedPersec }
    $m.NetUpKB = [math]::Round($up/1KB,1); $m.NetDownKB = [math]::Round($down/1KB,1)
  } catch {}
  $m
}
function Start-MetricsAsync {
  if ($null -ne $script:Metrics) { return }
  try {
    $rs = [runspacefactory]::CreateRunspace(); $rs.ApartmentState='MTA'; $rs.Open()
    $ps = [PowerShell]::Create(); $ps.Runspace=$rs; $null=$ps.AddScript($script:MetricsScript.ToString())
    $script:Metrics=$ps; $script:MetricsRs=$rs; $script:MetricsAsync=$ps.BeginInvoke()
  } catch { $script:Metrics=$null; $script:MetricsRs=$null; $script:MetricsAsync=$null }
}
function Receive-Metrics {
  if ($null -eq $script:Metrics -or -not $script:MetricsAsync.IsCompleted) { return }
  $m=$null; try { $out=$script:Metrics.EndInvoke($script:MetricsAsync); if ($out) { $m=$out[-1] } } catch {}
  try { $script:Metrics.Dispose() } catch {}; try { $script:MetricsRs.Dispose() } catch {}
  $script:Metrics=$null; $script:MetricsRs=$null; $script:MetricsAsync=$null
  if ($m -is [hashtable]) { Apply-Metrics $m }
}
function Apply-Metrics($m) {
  Push-Spark 'sigcpu' $m.SigCpu; $script:Analytics.sigcpu.Value.Text = ('{0}%' -f [int]$m.SigCpu)
  $script:Analytics.sigcpu.Sub.Text = if ($m.SigPid) { "PID $($m.SigPid)" } else { 'offline' }
  Update-Sparkline $script:Analytics.sigcpu.Spark $script:Spark.sigcpu
  Push-Spark 'sigmem' ([double]$m.SigMemMB); $script:Analytics.sigmem.Value.Text = (Format-Bytes ($m.SigMemMB*1MB))
  Update-Sparkline $script:Analytics.sigmem.Spark $script:Spark.sigmem
  $kb = [math]::Round($m.NetDownKB+$m.NetUpKB,1); Push-Spark 'net' $kb
  $script:Analytics.net.Value.Text = ('{0} KB/s' -f $kb); Update-Sparkline $script:Analytics.net.Spark $script:Spark.net
  Push-Spark 'cf' ([double]$m.CloudflaredCount); $script:Analytics.cf.Value.Text = ('{0}' -f $m.CloudflaredCount)
  Update-Sparkline $script:Analytics.cf.Spark $script:Spark.cf
  Push-Spark 'conns' ([double]$m.ActiveConns); $script:Analytics.conns.Value.Text = ('{0}' -f $m.ActiveConns)
  Update-Sparkline $script:Analytics.conns.Spark $script:Spark.conns
  $script:Ctl.TxtMiniConns.Text = ('{0}' -f $m.ActiveConns)
  $script:Res.sigcpu.Val.Text = ('{0}% (PID {1})' -f [int]$m.SigCpu, $(if ($m.SigPid){$m.SigPid}else{'-'}))
  $script:Res.sigmem.Val.Text = (Format-Bytes ($m.SigMemMB*1MB))
  $script:Res.net.Val.Text = ('down {0} KB/s · up {1} KB/s' -f $m.NetDownKB, $m.NetUpKB)
  $script:Res.conns.Val.Text = ('{0} established' -f $m.ActiveConns)
  $script:Res.cf.Val.Text = ('{0} process(es)' -f $m.CloudflaredCount)
  $up = Format-Uptime ([DateTime]::UtcNow - $script:SessionStartUtc)
  $script:Ctl.TxtAnalyticsHead.Text = ('uptime {0} · signal {1}% CPU · {2} conn(s)' -f $up, [int]$m.SigCpu, $m.ActiveConns)
}

$script:ProbeScript = {
  param($s)
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  function Test-Port([int]$P) {
    try { $c=New-Object Net.Sockets.TcpClient; $iar=$c.BeginConnect('127.0.0.1',$P,$null,$null)
      $ok=$iar.AsyncWaitHandle.WaitOne(450); if ($ok -and $c.Connected) { $c.EndConnect($iar); $c.Close(); return $true }
      $c.Close(); return $false } catch { return $false }
  }
  function Probe-Health([string]$Url) {
    $sw=[Diagnostics.Stopwatch]::StartNew(); $code=0; $body=''
    try { $r=Invoke-WebRequest -Uri $Url -TimeoutSec 8 -UseBasicParsing; $code=[int]$r.StatusCode; $body=[string]$r.Content } catch {
      $resp=$_.Exception.Response; if ($resp) { $code=[int]$resp.StatusCode }
    }
  return @{ Ms=$sw.ElapsedMilliseconds; Code=$code; Ok=($code -eq 200 -and $body -match 'ok') }
  }
  $r=@{}; $exe=Join-Path $s.RepoRoot 'signaling\target\release\gametracker-signal.exe'
  if (Test-Path -LiteralPath $exe) {
    $fi=Get-Item $exe; $ageH=[math]::Round(((Get-Date)-$fi.LastWriteTime).TotalHours,1)
    $r.build=@{ State='Online'; Detail="gametracker-signal.exe ready"; Extra=@("$([math]::Round($fi.Length/1MB,1)) MB","built ${ageH}h ago") }
  } else { $r.build=@{ State='Offline'; Detail='Binary not built'; Extra=@('cargo build --release') } }

  if ($s.RunnerActive) { $r.runner=@{ State='Online'; Detail="Running PID $($s.RunnerPid)"; Extra=@('Start-DiscoveryPublic.ps1') } }
  elseif ($s.RunnerExited) { $r.runner=@{ State='Idle'; Detail="Exited code $($s.RunnerExitCode)"; Extra=@() } }
  else { $r.runner=@{ State='Idle'; Detail='Not started this session'; Extra=@('Click Start Stack') } }

  $open=Test-Port $s.Port; $local=@{ Ms=0; Ok=$false; Code=0 }; $public=@{ Ms=0; Ok=$false; Code=0 }
  if ($open) {
    $local=Probe-Health "http://127.0.0.1:$($s.Port)/health"
    $r.signal=@{ State=$(if ($local.Ok){'Online'}else{'Degraded'}); Detail="GET /health $($local.Code) in $($local.Ms) ms"; Extra=@("http://127.0.0.1:$($s.Port)") }
  } else { $r.signal=@{ State='Offline'; Detail="Port $($s.Port) closed"; Extra=@('Start Stack') } }

  if ($s.LocalOnly -or $s.SkipTunnel) {
    $r.tunnel=@{ State='Idle'; Detail=$(if ($s.LocalOnly){'Local-only'}else{'Shared tunnel expected'}); Extra=@() }
  } else {
    $cf=@(Get-Process -Name cloudflared -ErrorAction SilentlyContinue)
    if ($cf.Count -gt 0) { $r.tunnel=@{ State='Online'; Detail="$($cf.Count) cloudflared process(es)"; Extra=@() } }
    else { $r.tunnel=@{ State='Offline'; Detail='No cloudflared detected'; Extra=@('Set CLOUDFLARED_TUNNEL_TOKEN') } }
  }

  if ($s.LocalOnly -or [string]::IsNullOrWhiteSpace($s.AppHost)) {
    $r.public=@{ State='Idle'; Detail='Local-only mode'; Extra=@() }
  } else {
    $public=Probe-Health "https://$($s.AppHost)/health"
    if ($public.Ok) { $r.public=@{ State='Online'; Detail="Public /health $($public.Code) in $($public.Ms) ms"; Extra=@("https://$($s.AppHost)") } }
    elseif ($public.Code -ge 500) { $r.public=@{ State='Degraded'; Detail="HTTP $($public.Code) - tunnel up, signal down?"; Extra=@() } }
    elseif ($public.Code -gt 0) { $r.public=@{ State='Degraded'; Detail="HTTP $($public.Code)"; Extra=@() } }
    else { $r.public=@{ State='Offline'; Detail='Cannot reach public hostname'; Extra=@() } }
  }

  $traffic=@{ Total=0; Get=0; Options=0; WS=0; S2xx=0; S3xx=0; S4xx=0; S5xx=0; Errors=0; SuccessPct=100.0
    LocalMs=[double]$local.Ms; PublicMs=[double]$public.Ms; LocalOk=$local.Ok; PublicOk=$public.Ok
    TopRoutes=@(@{Route='/health';Count=1;AvgMs=[int]$local.Ms},@{Route='/ws';Count=0;AvgMs=0},@{Route='/';Count=0;AvgMs=0}) }
  if ($local.Ok -or $local.Code -gt 0) { $traffic.Total++; $traffic.Get++; if ($local.Ok) { $traffic.S2xx++ } elseif ($local.Code -ge 500) { $traffic.S5xx++ } else { $traffic.S4xx++ } }
  if ($public.Ok -or $public.Code -gt 0) { $traffic.Total++; $traffic.Get++; if ($public.Ok) { $traffic.S2xx++ } elseif ($public.Code -ge 500) { $traffic.S5xx++ } else { $traffic.S4xx++ } }
  $traffic.Errors=$traffic.S4xx+$traffic.S5xx
  if ($traffic.Total -gt 0) { $traffic.SuccessPct=[math]::Round(100.0*($traffic.Total-$traffic.Errors)/$traffic.Total,1) }
  $r.traffic=$traffic; $r
}

function Start-ProbeAsync {
  if ($null -ne $script:Probe) { return }
  $arg=@{
    RunnerActive=($null -ne $script:RunnerProcess -and -not $script:RunnerProcess.HasExited)
    RunnerExited=($null -ne $script:RunnerProcess -and $script:RunnerProcess.HasExited)
    RunnerPid=$(if ($script:RunnerProcess) { $script:RunnerProcess.Id } else { 0 })
    RunnerExitCode=$(if ($script:RunnerProcess -and $script:RunnerProcess.HasExited) { $script:RunnerProcess.ExitCode } else { 0 })
    LocalOnly=[bool]$script:Ctl.ChkLocalOnly.IsChecked; SkipTunnel=[bool]$script:Ctl.ChkSkipTunnel.IsChecked
    Port=$script:Port; AppHost=$script:Ctl.TxtAppHost.Text.Trim(); RepoRoot=$script:RepoRoot
  }
  try {
    $rs=[runspacefactory]::CreateRunspace(); $rs.ApartmentState='MTA'; $rs.Open()
    $ps=[PowerShell]::Create(); $ps.Runspace=$rs; $null=$ps.AddScript($script:ProbeScript.ToString()).AddArgument($arg)
    $script:Probe=$ps; $script:ProbeRs=$rs; $script:ProbeAsync=$ps.BeginInvoke()
  } catch { $script:Probe=$null; $script:ProbeRs=$null; $script:ProbeAsync=$null }
}
function Receive-Probe {
  if ($null -eq $script:Probe -or -not $script:ProbeAsync.IsCompleted) { return }
  $r=$null; try { $out=$script:Probe.EndInvoke($script:ProbeAsync); if ($out) { $r=$out[-1] } } catch { Add-LogLine "Probe error: $_" 'WARN' }
  try { $script:Probe.Dispose() } catch {}; try { $script:ProbeRs.Dispose() } catch {}
  $script:Probe=$null; $script:ProbeRs=$null; $script:ProbeAsync=$null
  if ($r -is [hashtable]) { Apply-ProbeResult $r }
}
function Apply-Traffic($t) {
  Push-Spark 'localms' ([double]$t.LocalMs); $script:Analytics.localms.Value.Text = ('{0} ms' -f [int]$t.LocalMs)
  $script:Analytics.localms.Sub.Text = if ($t.LocalOk) { 'ok' } else { 'fail' }; Update-Sparkline $script:Analytics.localms.Spark $script:Spark.localms
  Push-Spark 'publicms' ([double]$t.PublicMs); $script:Analytics.publicms.Value.Text = ('{0} ms' -f [int]$t.PublicMs)
  $script:Analytics.publicms.Sub.Text = if ($t.PublicOk) { 'ok' } else { 'fail' }; Update-Sparkline $script:Analytics.publicms.Spark $script:Spark.publicms
  Push-Spark 'success' ([double]$t.SuccessPct); $script:Analytics.success.Value.Text = ('{0}%' -f $t.SuccessPct)
  Update-Sparkline $script:Analytics.success.Spark $script:Spark.success
  $script:Ctl.TxtMiniLocalMs.Text = ('{0}ms' -f [int]$t.LocalMs)
  $mvals=@{ GET=[int]$t.Get; OPTIONS=[int]$t.Options; WS=[int]$t.WS }; $mmax=1; foreach ($v in $mvals.Values) { if ($v -gt $mmax) { $mmax=$v } }
  foreach ($k in @('GET','OPTIONS','WS')) { Set-BarRow $script:MethodRows[$k] $mvals[$k] $mmax ('{0}' -f $mvals[$k]) }
  $svals=@{ '2xx'=[int]$t.S2xx; '3xx'=[int]$t.S3xx; '4xx'=[int]$t.S4xx; '5xx'=[int]$t.S5xx }; $smax=1
  foreach ($v in $svals.Values) { if ($v -gt $smax) { $smax=$v } }
  foreach ($k in @('2xx','3xx','4xx','5xx')) { Set-BarRow $script:StatusRows[$k] $svals[$k] $smax ('{0}' -f $svals[$k]) }
  $script:Ctl.RoutesHost.Children.Clear()
  foreach ($e in @($t.TopRoutes)) {
    $g=New-Object System.Windows.Controls.Grid; $g.Margin='0,0,0,6'
    $g.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition -Property @{Width='*'}))
    $g.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition -Property @{Width='60'}))
    $rt=New-Object System.Windows.Controls.TextBlock; $rt.Text=[string]$e.Route; $rt.FontFamily='Consolas'; $rt.FontSize=11.5
    $cnt=New-Object System.Windows.Controls.TextBlock; $cnt.Text=('{0} ms' -f [int]$e.AvgMs); $cnt.HorizontalAlignment='Right'
    [System.Windows.Controls.Grid]::SetColumn($rt,0); [System.Windows.Controls.Grid]::SetColumn($cnt,1)
    $g.Children.Add($rt)|Out-Null; $g.Children.Add($cnt)|Out-Null; $script:Ctl.RoutesHost.Children.Add($g)|Out-Null
  }
}
function Apply-ProbeResult($r) {
  $script:LastResult=$r
  foreach ($k in $r.Keys) {
    if (-not $script:Cards.ContainsKey($k)) { continue }
    $v=$r[$k]; $extra=@(); if ($v.ContainsKey('Extra') -and $v.Extra) { $extra=@($v.Extra) }
    Set-CardState $k $v.State $v.Detail $extra
  }
  if ($r.ContainsKey('traffic')) { Apply-Traffic $r.traffic }
  $localOnly=[bool]$script:Ctl.ChkLocalOnly.IsChecked
  $expected=@('signal'); if (-not $localOnly) { $expected+=@('tunnel','public') }
  $up=0; foreach ($k in $expected) { if ($r.ContainsKey($k) -and $r[$k].State -eq 'Online') { $up++ } }
  $pct=if ($expected.Count) { [int](100*$up/$expected.Count) } else { 0 }
  Animate-Double $script:Ctl.ProgOverall ([System.Windows.Controls.Primitives.RangeBase]::ValueProperty) $pct 500
  $hex=if ($up -eq $expected.Count) { $Palette.Online } elseif ($up -eq 0) { $Palette.Offline } else { $Palette.Degraded }
  $hb=ConvertTo-Brush $hex; $script:Ctl.HealthDot.Fill=$hb; $script:Ctl.HealthGlow.Color=(ConvertTo-Color $hex)
  $script:Ctl.TxtHealth.Text="$up / $($expected.Count) services online"; $script:Ctl.TxtMiniServices.Text="$up/$($expected.Count)"
  if (-not $localOnly -and $r.public.State -eq 'Degraded' -and $r.signal.State -eq 'Offline') {
    Show-Diagnosis 'Public discovery returns 502 - signaling server is down' 'Cloudflare reached your PC but nothing answers on :8080. Click Start Stack.'
  } elseif ($r.signal.State -eq 'Offline' -and $r.runner.State -ne 'Online') {
    Show-Diagnosis 'Signaling server not running' 'Click Start Stack to build (if needed) and start gametracker-signal on port 8080.'
  } else { Hide-Diagnosis }
}

function Build-StartArgs {
  $a=@('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$script:StartScriptPath`"")
  if ($script:Ctl.ChkLocalOnly.IsChecked) { $a+='-LocalOnly' }
  if ($script:Ctl.ChkSkipBuild.IsChecked) { $a+='-SkipBuild' }
  if ($script:Ctl.ChkCustomDomain.IsChecked) { $a+='-UseCustomDomain' }
  if ($script:Ctl.ChkSkipTunnel.IsChecked) { $a+='-SkipTunnel' }
  $h=$script:Ctl.TxtAppHost.Text.Trim(); if ($h) { $a+=@('-AppHostname',"`"$h`"") }
  $a+=@('-Port',"$script:Port"); return $a
}
function Start-Stack {
  if ($null -ne $script:RunnerProcess -and -not $script:RunnerProcess.HasExited) { Add-LogLine 'Runner already active.' 'WARN'; return }
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName='powershell.exe'; $psi.WorkingDirectory=$script:RepoRoot; $psi.Arguments=(Build-StartArgs -join ' ')
  $psi.UseShellExecute=$false; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $psi.CreateNoWindow=$true
  $proc=New-Object Diagnostics.Process; $proc.StartInfo=$psi; $proc.EnableRaisingEvents=$true
  if (-not $proc.Start()) { Add-LogLine 'Failed to start runner.' 'ERR'; return }
  $script:RunnerProcess=$proc; $script:Ctl.BtnStart.IsEnabled=$false; $script:Ctl.BtnStop.IsEnabled=$true
  $script:Ctl.TxtStep.Text='Startup initiated'
  if ($script:OutSub) { Unregister-Event -SourceIdentifier $script:OutSub.Name -ErrorAction SilentlyContinue }
  if ($script:ErrSub) { Unregister-Event -SourceIdentifier $script:ErrSub.Name -ErrorAction SilentlyContinue }
  $script:OutSub=Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
    $line=$Event.SourceEventArgs.Data; if (-not $line) { return }
    $lvl='INFO'; if ($line -match '===\s+(.+?)\s+===') { $lvl='STEP' }
    elseif ($line -match '(?i)error|failed') { $lvl='ERR' } elseif ($line -match '(?i)warn') { $lvl='WARN' } elseif ($line -match '(?i)listening|ready|ok') { $lvl='OK' }
    $global:DiscoveryLogQueue.Enqueue([pscustomobject]@{ Stamp=(Get-Date -Format 'HH:mm:ss'); Level=$lvl; Text=$line })
  }
  $script:ErrSub=Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
    $line=$Event.SourceEventArgs.Data; if ($line) { $global:DiscoveryLogQueue.Enqueue([pscustomobject]@{ Stamp=(Get-Date -Format 'HH:mm:ss'); Level='ERR'; Text=$line }) }
  }
  $proc.BeginOutputReadLine(); $proc.BeginErrorReadLine(); Add-LogLine "Runner PID $($proc.Id)" 'OK'
}
function Stop-Stack {
  if ($script:StopBusy) { return }
  if ([System.Windows.MessageBox]::Show('Stop the discovery stack?','Discovery','YesNo','Question') -ne 'Yes') { return }
  $script:StopBusy=$true; $script:Ctl.BtnStop.IsEnabled=$false; $window.Cursor=[System.Windows.Input.Cursors]::Wait
  try {
    function Stop-Tree([int]$processId) {
      foreach ($k in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" -ErrorAction SilentlyContinue)) { Stop-Tree $k.ProcessId }
      try { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($script:RunnerProcess -and -not $script:RunnerProcess.HasExited) { Stop-Tree $script:RunnerProcess.Id }
    foreach ($c in @(Get-NetTCPConnection -LocalPort $script:Port -State Listen -ErrorAction SilentlyContinue)) {
      if ($c.OwningProcess -gt 0) { $pn=(Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        if ($pn -match 'gametracker-signal') { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } }
    }
    Add-LogLine 'Stack stopped (shared cloudflared left running).' 'OK'
  } finally {
    $window.Cursor=[System.Windows.Input.Cursors]::Arrow; $script:StopBusy=$false
    $script:Ctl.BtnStart.IsEnabled=$true; $script:Ctl.TxtStep.Text='Stopped'; Start-ProbeAsync
  }
}
function Start-Repair([string]$Label, [string]$Body) {
  $repairLog=Join-Path $script:LogDir 'repair.log'
  $tmp=Join-Path $env:TEMP ("discovery-repair-"+[guid]::NewGuid().ToString('N')+'.ps1')
  $content=@"
Set-Location -LiteralPath '$script:RepoRoot'
`$RepairLog='$repairLog'
('==== $Label @ ' + (Get-Date -Format o) + ' ====') | Add-Content -LiteralPath `$RepairLog
try { & { $Body } *>&1 | Out-String | Add-Content `$RepairLog } catch { `$_ | Out-String | Add-Content `$RepairLog }
Remove-Item -LiteralPath '$tmp' -Force -ErrorAction SilentlyContinue
"@
  [IO.File]::WriteAllText($tmp,$content,[Text.UTF8Encoding]::new($false))
  Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$tmp`"") -WindowStyle Hidden | Out-Null
  Add-LogLine "$Label launched (repair.log)" 'OK'
}
function Free-Port([int]$P) {
  foreach ($c in @(Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue)) {
    if ($c.OwningProcess -gt 0) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
  Add-LogLine "Freed port $P" 'OK'; Start-ProbeAsync
}
function Stop-Cloudflared {
  @(Get-Process -Name cloudflared -ErrorAction SilentlyContinue) | Stop-Process -Force -ErrorAction SilentlyContinue
  Add-LogLine 'Stopped cloudflared.' 'OK'; Start-ProbeAsync
}
function Build-DiagnosticsReport {
  $sb=New-Object Text.StringBuilder
  [void]$sb.AppendLine('=== Discovery Control Center diagnostics ===')
  [void]$sb.AppendLine("Time: $(Get-Date -Format o)"); [void]$sb.AppendLine("Host: $($script:Ctl.TxtAppHost.Text)")
  if ($script:LastResult) { foreach ($k in @('runner','signal','build','tunnel','public')) {
    if ($script:LastResult.ContainsKey($k)) { $v=$script:LastResult[$k]; [void]$sb.AppendLine(("  {0,-8} {1,-9} {2}" -f $k,$v.State,$v.Detail)) } } }
  return $sb.ToString()
}

# wiring
$script:Ctl.BtnStart.Add_Click({ Start-Stack })
$script:Ctl.BtnStop.Add_Click({ Stop-Stack })
$script:Ctl.BtnRestart.Add_Click({ if ($script:RunnerProcess -and -not $script:RunnerProcess.HasExited) { Stop-Stack }; Start-Sleep 2; Start-Stack })
$script:Ctl.BtnRecheck.Add_Click({ Start-ProbeAsync })
$script:Ctl.BtnOpenLocal.Add_Click({ Start-Process "http://127.0.0.1:$($script:Port)/health" })
$script:Ctl.BtnOpenPublic.Add_Click({ $h=$script:Ctl.TxtAppHost.Text.Trim(); if ($h) { Start-Process "https://$h/health" } })
$script:Ctl.BtnOpenLogs.Add_Click({ Start-Process explorer.exe $script:LogDir })
$script:Ctl.BtnCopyDiag.Add_Click({ try { [Windows.Clipboard]::SetText((Build-DiagnosticsReport)); Add-LogLine 'Copied diagnostics.' 'OK' } catch {} })
$script:Ctl.BtnCargoBuild.Add_Click({ Start-Repair 'cargo build' "cargo build --release --manifest-path signaling/Cargo.toml" })
$script:Ctl.BtnRestartSignal.Add_Click({ Free-Port $script:Port })
$script:Ctl.BtnStartTunnel.Add_Click({ Start-Repair 'cloudflared' 'npx --yes cloudflared tunnel --no-autoupdate run --token $env:CLOUDFLARED_TUNNEL_TOKEN' })
$script:Ctl.BtnFreePort.Add_Click({ Free-Port $script:Port })
$script:Ctl.BtnKillTunnel.Add_Click({ Stop-Cloudflared })
$script:Ctl.BtnFlushDns.Add_Click({ ipconfig /flushdns | Out-Null; Add-LogLine 'DNS flushed.' 'OK' })
$script:Ctl.BtnTestHealth.Add_Click({ Start-ProbeAsync; Invoke-ServiceLogSelect 'public' })
$script:Ctl.BtnCopyCurl.Add_Click({
  $h=$script:Ctl.TxtAppHost.Text.Trim(); $curl="curl -sS https://$h/health"
  try { [Windows.Clipboard]::SetText($curl); Add-LogLine 'Copied curl command.' 'OK' } catch {}
})
$script:Ctl.BtnSignalLog.Add_Click({ Invoke-ServiceLogSelect 'signal' })
$script:Ctl.BtnRepairLog.Add_Click({ Invoke-ServiceLogSelect 'repair' })
$script:Ctl.BtnOpenRepo.Add_Click({ Start-Process explorer.exe $script:RepoRoot })
$script:Ctl.BtnWinMin.Add_Click({ $window.WindowState='Minimized' })
$script:Ctl.BtnWinMax.Add_Click({ if ($window.WindowState -eq 'Maximized') { $window.WindowState='Normal' } else { $window.WindowState='Maximized' } })
$script:Ctl.BtnWinClose.Add_Click({ $window.Close() })
$script:Ctl.ChkLocalOnly.Add_Checked({ $script:Ctl.ChkCustomDomain.IsChecked=$false; $script:Ctl.TxtAppHost.IsEnabled=$false })
$script:Ctl.ChkLocalOnly.Add_Unchecked({ $script:Ctl.TxtAppHost.IsEnabled=$true })
$script:Ctl.CmbLogSource.Add_SelectionChanged({ if (-not $script:SuppressLogSourceChange) { Invoke-ServiceLogSelect (Get-LogSourceKey) } })
$script:Ctl.BtnRefreshSvcLog.Add_Click({ Invoke-ServiceLogSelect (Get-LogSourceKey) })

$uiTimer = New-Object Windows.Threading.DispatcherTimer
$uiTimer.Interval = [TimeSpan]::FromMilliseconds(400)
$uiTimer.Add_Tick({
  try {
    $entry=$null; $drained=0; $added=$false
    while ($drained -lt 60 -and $global:DiscoveryLogQueue.TryDequeue([ref]$entry)) {
      $drained++; if (-not $entry) { continue }
      if ($entry.Level -eq 'STEP' -and $entry.Text -match '===\s+(.+?)\s+===') { $script:Ctl.TxtStep.Text = "Step: $($Matches[1])" }
      $script:AllLogEntries.Add($entry)|Out-Null
      if ((Get-LogSourceKey) -eq 'activity' -and (Test-LogPassesFilter $entry)) {
        $script:Ctl.LbLogs.Items.Add((New-LogListItem $entry))|Out-Null; $added=$true
        if ($script:Ctl.LbLogs.Items.Count -gt 2000) { $script:Ctl.LbLogs.Items.RemoveAt(0) }
      }
    }
    if ($added -and $script:Ctl.ChkAutoScroll.IsChecked -and $script:Ctl.LbLogs.Items.Count -gt 0) {
      $script:Ctl.LbLogs.ScrollIntoView($script:Ctl.LbLogs.Items[$script:Ctl.LbLogs.Items.Count-1])
    }
    Receive-Probe; $now=[DateTime]::UtcNow
    if ($null -eq $script:Probe -and ($now-$script:LastPollUtc).TotalMilliseconds -ge 4000) { Start-ProbeAsync; $script:LastPollUtc=$now }
    Receive-Metrics
    if ($null -eq $script:Metrics -and ($now-$script:LastMetricsStartUtc).TotalMilliseconds -ge 1500) { Start-MetricsAsync; $script:LastMetricsStartUtc=$now }
  } catch { Add-LogLine "tick error: $_" 'ERR' }
})
$uiTimer.Start()
Add-LogLine 'Discovery Control Center ready.' 'OK'
if ($script:Ctl.ChkAutoStart.IsChecked) { Start-Stack } else { Start-ProbeAsync; Start-MetricsAsync }
[void]$window.ShowDialog()
$uiTimer.Stop()
if ($script:RunnerProcess -and -not $script:RunnerProcess.HasExited) { try { $script:RunnerProcess.Kill() } catch {} }
