<#
.SYNOPSIS
  ChilloutDashboardKit - a reusable WPF "retro-hacker + modern" UI kit for Chillout
  startup command centers (Nexus, Jewellery, WikiRacer, ChilloutSite, ...).

.DESCRIPTION
  Dot-source this from any *ControlCenter.ps1 to get a single source of truth for:
    * the dark "terminal phosphor" theme tokens ($global:ChilloutTheme)
    * the shared Window.Resources XAML (Get-CgResourceXaml) - modern buttons,
      pill toggles, dark ComboBox, thin rounded scrollbars, glowing progress bar,
      scanline texture - all themed from the tokens so a new app only overrides
      $global:ChilloutTheme then calls Get-CgResourceXaml.
    * framework-agnostic builders (New-CgMetricTile, New-CgBarRow, New-CgSectionHeader,
      New-CgResLine, New-CgToolButton) and helpers (sparklines, animation, pulse,
      brush/colour conversion, byte/uptime formatting).

  The builders create plain WPF objects and hold no app state, so they are safe to
  reuse verbatim across every Chillout dashboard. App-specific wiring (probe/metrics
  runspaces, Apply-* functions, service rows) stays in each app's ControlCenter.ps1.

  Save as UTF-8 with BOM (PowerShell 5.1 reads the glyphs correctly).
#>

# Idempotent: safe to dot-source more than once / standalone.
try { Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml -ErrorAction SilentlyContinue | Out-Null } catch {}

# ---------------------------------------------------------------------------
# Theme tokens - "Nexus terminal phosphor". Override before Get-CgResourceXaml
# to reskin a different app while keeping every component consistent.
# ---------------------------------------------------------------------------
if (-not (Test-Path 'variable:global:ChilloutTheme') -or -not $global:ChilloutTheme) {
  $global:ChilloutTheme = @{
    Bg        = '#06090D'   # window base (near-black, faint blue)
    Bg2       = '#080C12'
    Panel     = '#0B1119'   # section cards / header
    Card      = '#0D141C'   # tiles, service rows
    CardHi    = '#101A24'   # hover
    Edge      = '#1B2A38'   # default borders
    EdgeHi    = '#284155'   # hover / focus borders
    Text      = '#D8E6EF'   # primary text
    Sub       = '#7F93A7'   # secondary labels
    Dim       = '#586A7B'   # tertiary
    Accent    = '#22D3EE'   # cyan - primary actions / selection / sparklines
    Accent2   = '#3DF5A0'   # phosphor green - terminal vibe / online
    Accent3   = '#8B7CF6'   # violet
    Amber     = '#F5B544'
    Red       = '#FF5C6C'
    Online    = '#34F5A0'
    Degraded  = '#F5B544'
    Offline   = '#FF5C6C'
    Checking  = '#37C6F0'
    Idle      = '#586A7B'
    LogBg     = '#05080B'
    TrackBg   = '#111A24'   # progress/bar tracks
    ThumbBg   = '#243646'   # scrollbar thumb
    ThumbHi   = '#22D3EE'   # scrollbar thumb hover
  }
}

# ---------------------------------------------------------------------------
# Brush / colour / animation helpers (canonical names kept short so apps that
# previously defined them locally keep working after switching to the kit).
# ---------------------------------------------------------------------------
function ConvertTo-Brush([string]$Hex) {
  return New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($Hex))
}
function ConvertTo-Color([string]$Hex) {
  return [System.Windows.Media.ColorConverter]::ConvertFromString($Hex)
}

$script:CgPulse = New-Object System.Windows.Media.Animation.DoubleAnimation
$script:CgPulse.From = 1.0
$script:CgPulse.To = 0.25
$script:CgPulse.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(720))
$script:CgPulse.AutoReverse = $true
$script:CgPulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever

function Start-Pulse($element) { $element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $script:CgPulse) }
function Stop-Pulse($element)  { $element.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null); $element.Opacity = 1.0 }

function Animate-Double($element, $dp, [double]$to, [int]$ms = 380) {
  $a = New-Object System.Windows.Media.Animation.DoubleAnimation
  $a.To = $to
  $a.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds($ms))
  $a.EasingFunction = (New-Object System.Windows.Media.Animation.CubicEase -Property @{ EasingMode = 'EaseOut' })
  $element.BeginAnimation($dp, $a)
}

function Format-Uptime([TimeSpan]$ts) { return ('{0:00}:{1:00}:{2:00}' -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds) }
function Format-Bytes([double]$bytes) {
  if ($bytes -ge 1GB) { return ('{0} GB' -f [math]::Round($bytes / 1GB, 1)) }
  if ($bytes -ge 1MB) { return ('{0} MB' -f [math]::Round($bytes / 1MB, 0)) }
  if ($bytes -ge 1KB) { return ('{0} KB' -f [math]::Round($bytes / 1KB, 0)) }
  return ('{0} B' -f [int]$bytes)
}

# ---------------------------------------------------------------------------
# Shared Window.Resources XAML (themed from $global:ChilloutTheme).
# Returns the *inner* content of <Window.Resources> so each app can inject it
# into its own window with $(Get-CgResourceXaml).
# ---------------------------------------------------------------------------
function Get-CgResourceXaml {
  $t = $global:ChilloutTheme
  return @"
    <SolidColorBrush x:Key="Bg"        Color="$($t.Bg)"/>
    <SolidColorBrush x:Key="Bg2"       Color="$($t.Bg2)"/>
    <SolidColorBrush x:Key="Panel"     Color="$($t.Panel)"/>
    <SolidColorBrush x:Key="Card"      Color="$($t.Card)"/>
    <SolidColorBrush x:Key="CardHi"    Color="$($t.CardHi)"/>
    <SolidColorBrush x:Key="Edge"      Color="$($t.Edge)"/>
    <SolidColorBrush x:Key="EdgeHi"    Color="$($t.EdgeHi)"/>
    <SolidColorBrush x:Key="Text"      Color="$($t.Text)"/>
    <SolidColorBrush x:Key="SubText"   Color="$($t.Sub)"/>
    <SolidColorBrush x:Key="Dim"       Color="$($t.Dim)"/>
    <SolidColorBrush x:Key="Accent"    Color="$($t.Accent)"/>
    <SolidColorBrush x:Key="Accent2"   Color="$($t.Accent2)"/>
    <SolidColorBrush x:Key="Accent3"   Color="$($t.Accent3)"/>
    <SolidColorBrush x:Key="Amber"     Color="$($t.Amber)"/>
    <SolidColorBrush x:Key="Red"       Color="$($t.Red)"/>
    <SolidColorBrush x:Key="LogBg"     Color="$($t.LogBg)"/>

    <!-- Subtle CRT scanline texture (overlay, low opacity) -->
    <DrawingBrush x:Key="ScanLines" TileMode="Tile" Viewport="0,0,3,3" ViewportUnits="Absolute">
      <DrawingBrush.Drawing>
        <GeometryDrawing Brush="$($t.Accent)">
          <GeometryDrawing.Geometry><RectangleGeometry Rect="0,0,3,1"/></GeometryDrawing.Geometry>
        </GeometryDrawing>
      </DrawingBrush.Drawing>
    </DrawingBrush>

    <Style TargetType="ToolTip">
      <Setter Property="Background" Value="$($t.Panel)"/>
      <Setter Property="Foreground" Value="$($t.Text)"/>
      <Setter Property="BorderBrush" Value="$($t.EdgeHi)"/>
      <Setter Property="FontSize" Value="12"/>
    </Style>

    <!-- ===== Modern thin rounded scrollbars (apply everywhere) ===== -->
    <Style x:Key="CgScrollThumb" TargetType="Thumb">
      <Setter Property="OverridesDefaultStyle" Value="True"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Thumb">
            <Border CornerRadius="4" Background="{TemplateBinding Background}" SnapsToDevicePixels="True"/>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="CgScrollRepeat" TargetType="RepeatButton">
      <Setter Property="OverridesDefaultStyle" Value="True"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Focusable" Value="False"/>
      <Setter Property="IsTabStop" Value="False"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="RepeatButton"><Border Background="Transparent"/></ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Width" Value="11"/>
      <Setter Property="MinWidth" Value="11"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track" Orientation="{TemplateBinding Orientation}" IsDirectionReversed="True">
                <Track.DecreaseRepeatButton>
                  <RepeatButton Style="{StaticResource CgScrollRepeat}" Command="ScrollBar.PageUpCommand"/>
                </Track.DecreaseRepeatButton>
                <Track.Thumb>
                  <Thumb x:Name="CgThumb" Style="{StaticResource CgScrollThumb}" Background="$($t.ThumbBg)" Margin="3,2"/>
                </Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Style="{StaticResource CgScrollRepeat}" Command="ScrollBar.PageDownCommand"/>
                </Track.IncreaseRepeatButton>
              </Track>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="Orientation" Value="Horizontal">
                <Setter Property="Width" Value="Auto"/>
                <Setter Property="Height" Value="11"/>
                <Setter Property="MinWidth" Value="0"/>
                <Setter TargetName="PART_Track" Property="IsDirectionReversed" Value="False"/>
                <Setter TargetName="CgThumb" Property="Margin" Value="2,3"/>
              </Trigger>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="CgThumb" Property="Background" Value="$($t.ThumbHi)"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- ===== Buttons ===== -->
    <!-- Ghost / secondary -->
    <Style x:Key="Ghost" TargetType="Button">
      <Setter Property="Foreground" Value="$($t.Text)"/>
      <Setter Property="Background" Value="#13202C"/>
      <Setter Property="BorderBrush" Value="$($t.Edge)"/>
      <Setter Property="Padding" Value="13,7"/>
      <Setter Property="Margin" Value="0,0,7,7"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="8" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Background" Value="#1A2A38"/>
                <Setter TargetName="b" Property="BorderBrush" Value="$($t.Accent)"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="b" Property="Background" Value="#10202C"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.4"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Primary - cyan gradient with glow -->
    <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource Ghost}">
      <Setter Property="Foreground" Value="#04121A"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="8" BorderThickness="0">
              <Border.Background>
                <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
                  <GradientStop Color="$($t.Accent2)" Offset="0"/>
                  <GradientStop Color="$($t.Accent)" Offset="0.55"/>
                  <GradientStop Color="#0EA5C4" Offset="1"/>
                </LinearGradientBrush>
              </Border.Background>
              <Border.Effect><DropShadowEffect Color="$($t.Accent)" BlurRadius="14" ShadowDepth="0" Opacity="0.0"/></Border.Effect>
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Effect">
                  <Setter.Value><DropShadowEffect Color="$($t.Accent)" BlurRadius="18" ShadowDepth="0" Opacity="0.65"/></Setter.Value>
                </Setter>
              </Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.82"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.4"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Danger -->
    <Style x:Key="Danger" TargetType="Button" BasedOn="{StaticResource Ghost}">
      <Setter Property="Foreground" Value="#FFE4E6"/>
      <Setter Property="Background" Value="#33121A"/>
      <Setter Property="BorderBrush" Value="#7F1D2E"/>
    </Style>

    <!-- Tool - amber-tinted troubleshooting CTA, compact -->
    <Style x:Key="Tool" TargetType="Button" BasedOn="{StaticResource Ghost}">
      <Setter Property="Foreground" Value="#FCE9C7"/>
      <Setter Property="Background" Value="#15161A"/>
      <Setter Property="BorderBrush" Value="#3A3320"/>
      <Setter Property="Padding" Value="9,5"/>
      <Setter Property="Margin" Value="0,0,5,5"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="7" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Background" Value="#241F12"/>
                <Setter TargetName="b" Property="BorderBrush" Value="$($t.Amber)"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Background" Value="#191711"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.4"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Term - green phosphor outline CTA -->
    <Style x:Key="Term" TargetType="Button" BasedOn="{StaticResource Tool}">
      <Setter Property="Foreground" Value="#CFFBE6"/>
      <Setter Property="Background" Value="#0B1813"/>
      <Setter Property="BorderBrush" Value="#1E4634"/>
    </Style>

    <!-- Window caption button (min/max/close) -->
    <Style x:Key="Caption" TargetType="Button">
      <Setter Property="Foreground" Value="$($t.Sub)"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Width" Value="44"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FontFamily" Value="Segoe UI"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Background" Value="#1A2A38"/>
                <Setter Property="Foreground" Value="$($t.Text)"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="CaptionClose" TargetType="Button" BasedOn="{StaticResource Caption}">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Background" Value="#E11D48"/>
                <Setter Property="Foreground" Value="#FFFFFF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- iOS-style pill toggle for all checkboxes -->
    <Style TargetType="CheckBox">
      <Setter Property="Foreground" Value="$($t.Text)"/>
      <Setter Property="Margin" Value="0,0,16,9"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
              <Border x:Name="Track" Width="42" Height="23" CornerRadius="12"
                      Background="#16212C" BorderBrush="$($t.Edge)" BorderThickness="1"
                      Margin="0,0,9,0" VerticalAlignment="Center">
                <Ellipse x:Name="Thumb" Width="17" Height="17" Fill="$($t.Dim)"
                         HorizontalAlignment="Left" Margin="3,0,0,0" VerticalAlignment="Center">
                  <Ellipse.Effect><DropShadowEffect Color="#000000" BlurRadius="4" ShadowDepth="1" Opacity="0.35"/></Ellipse.Effect>
                </Ellipse>
              </Border>
              <ContentPresenter VerticalAlignment="Center" RecognizesAccessKey="True"/>
            </StackPanel>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Track" Property="BorderBrush" Value="$($t.EdgeHi)"/></Trigger>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Track" Property="Background" Value="#0C4A55"/>
                <Setter TargetName="Track" Property="BorderBrush" Value="$($t.Accent)"/>
                <Setter TargetName="Thumb" Property="Fill" Value="$($t.Accent)"/>
                <Setter TargetName="Thumb" Property="HorizontalAlignment" Value="Right"/>
                <Setter TargetName="Thumb" Property="Margin" Value="0,0,3,0"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="Label"><Setter Property="Foreground" Value="$($t.Sub)"/></Style>
    <Style TargetType="TextBox">
      <Setter Property="Background" Value="#0A121A"/>
      <Setter Property="Foreground" Value="$($t.Text)"/>
      <Setter Property="BorderBrush" Value="$($t.Edge)"/>
      <Setter Property="CaretBrush" Value="$($t.Accent)"/>
      <Setter Property="Padding" Value="6,4"/>
      <Setter Property="BorderThickness" Value="1"/>
    </Style>

    <!-- Modern dark ComboBox -->
    <Style x:Key="ComboItem" TargetType="ComboBoxItem">
      <Setter Property="Foreground" Value="$($t.Text)"/>
      <Setter Property="Padding" Value="10,7"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ComboBoxItem">
            <Border x:Name="ib" Background="Transparent" CornerRadius="6" Padding="{TemplateBinding Padding}" Margin="3,1">
              <ContentPresenter/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsHighlighted" Value="True"><Setter TargetName="ib" Property="Background" Value="#16242F"/></Trigger>
              <Trigger Property="IsSelected" Value="True"><Setter TargetName="ib" Property="Background" Value="#0C4A55"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ComboBox">
      <Setter Property="Foreground" Value="$($t.Text)"/>
      <Setter Property="Background" Value="#0A121A"/>
      <Setter Property="BorderBrush" Value="$($t.Edge)"/>
      <Setter Property="Height" Value="30"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="ItemContainerStyle" Value="{StaticResource ComboItem}"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ComboBox">
            <Grid>
              <ToggleButton x:Name="Toggle" Focusable="False" ClickMode="Press"
                            IsChecked="{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}">
                <ToggleButton.Template>
                  <ControlTemplate TargetType="ToggleButton">
                    <Border x:Name="tb" CornerRadius="8" Background="#0A121A" BorderBrush="$($t.Edge)" BorderThickness="1" Padding="10,0">
                      <Path HorizontalAlignment="Right" Data="M0,0 L8,0 L4,5 Z" Fill="$($t.Sub)" VerticalAlignment="Center" Margin="0,2,4,0"/>
                    </Border>
                    <ControlTemplate.Triggers>
                      <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="tb" Property="BorderBrush" Value="$($t.Accent)"/></Trigger>
                    </ControlTemplate.Triggers>
                  </ControlTemplate>
                </ToggleButton.Template>
              </ToggleButton>
              <ContentPresenter x:Name="ContentSite" IsHitTestVisible="False"
                                Content="{TemplateBinding SelectionBoxItem}" Margin="12,0,28,0" VerticalAlignment="Center"/>
              <Popup x:Name="Popup" Placement="Bottom" AllowsTransparency="True" Focusable="False"
                     IsOpen="{TemplateBinding IsDropDownOpen}" PopupAnimation="Slide">
                <Border Background="$($t.Panel)" BorderBrush="$($t.EdgeHi)" BorderThickness="1" CornerRadius="8"
                        MinWidth="{TemplateBinding ActualWidth}" Margin="0,4,0,0">
                  <Border.Effect><DropShadowEffect Color="#000000" BlurRadius="16" ShadowDepth="2" Opacity="0.55"/></Border.Effect>
                  <ScrollViewer MaxHeight="320"><ItemsPresenter/></ScrollViewer>
                </Border>
              </Popup>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Glowing modern progress bar -->
    <Style TargetType="ProgressBar">
      <Setter Property="Background" Value="#0A121A"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Foreground" Value="$($t.Accent)"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ProgressBar">
            <Border CornerRadius="4" Background="{TemplateBinding Background}" ClipToBounds="True">
              <Grid>
                <Border x:Name="PART_Track"/>
                <Border x:Name="PART_Indicator" HorizontalAlignment="Left" CornerRadius="4">
                  <Border.Background>
                    <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                      <GradientStop Color="$($t.Accent2)" Offset="0"/>
                      <GradientStop Color="$($t.Accent)" Offset="1"/>
                    </LinearGradientBrush>
                  </Border.Background>
                  <Border.Effect><DropShadowEffect Color="$($t.Accent)" BlurRadius="9" ShadowDepth="0" Opacity="0.6"/></Border.Effect>
                </Border>
              </Grid>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
"@
}

# ---------------------------------------------------------------------------
# Builders - plain WPF objects, no app state. Reusable across dashboards.
# ---------------------------------------------------------------------------

# Compact KPI tile: accent bar + title + big mono value + sub + body (sparkline/bars).
function New-MetricTile([string]$Title, [string]$Accent, [double]$Width = 152, [double]$Height = 94) {
  $t = $global:ChilloutTheme
  $card = New-Object System.Windows.Controls.Border
  $card.Width = $Width; $card.Height = $Height
  $card.CornerRadius = [System.Windows.CornerRadius]::new(10)
  $card.Background = ConvertTo-Brush $t.Card
  $card.BorderBrush = ConvertTo-Brush $t.Edge
  $card.BorderThickness = [System.Windows.Thickness]::new(1)
  $card.Margin = [System.Windows.Thickness]::new(5)
  $card.Padding = [System.Windows.Thickness]::new(11, 8, 11, 8)

  # Hover lift: brighten border + faint accent glow.
  $card.Add_MouseEnter({ param($s,$e)
    $s.BorderBrush = (ConvertTo-Brush $global:ChilloutTheme.EdgeHi)
    $s.Background = (ConvertTo-Brush $global:ChilloutTheme.CardHi)
  })
  $card.Add_MouseLeave({ param($s,$e)
    $s.BorderBrush = (ConvertTo-Brush $global:ChilloutTheme.Edge)
    $s.Background = (ConvertTo-Brush $global:ChilloutTheme.Card)
  })

  $sp = New-Object System.Windows.Controls.StackPanel
  $row = New-Object System.Windows.Controls.StackPanel; $row.Orientation = 'Horizontal'
  $accentBar = New-Object System.Windows.Shapes.Rectangle
  $accentBar.Width = 4; $accentBar.Height = 11; $accentBar.RadiusX = 2; $accentBar.RadiusY = 2
  $accentBar.Fill = ConvertTo-Brush $Accent; $accentBar.Margin = [System.Windows.Thickness]::new(0,0,7,0)
  $accentBar.VerticalAlignment = 'Center'
  $glow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $glow.ShadowDepth = 0; $glow.BlurRadius = 7; $glow.Color = (ConvertTo-Color $Accent); $glow.Opacity = 0.8
  $accentBar.Effect = $glow
  $ti = New-Object System.Windows.Controls.TextBlock
  $ti.Text = $Title; $ti.FontSize = 10.5; $ti.Foreground = ConvertTo-Brush $t.Sub
  $ti.FontFamily = New-Object System.Windows.Media.FontFamily 'Cascadia Mono, Consolas'
  $ti.FontWeight = 'SemiBold'; $ti.VerticalAlignment = 'Center'; $ti.TextTrimming = 'CharacterEllipsis'
  $row.Children.Add($accentBar) | Out-Null; $row.Children.Add($ti) | Out-Null
  $sp.Children.Add($row) | Out-Null

  $val = New-Object System.Windows.Controls.TextBlock
  $val.Text = '--'; $val.FontSize = 21; $val.FontWeight = 'Bold'
  $val.FontFamily = New-Object System.Windows.Media.FontFamily 'Cascadia Mono, Consolas'
  $val.Foreground = ConvertTo-Brush $t.Text; $val.Margin = [System.Windows.Thickness]::new(0,1,0,0)
  $sp.Children.Add($val) | Out-Null

  $sub = New-Object System.Windows.Controls.TextBlock
  $sub.Text = ''; $sub.FontSize = 9.5; $sub.Foreground = ConvertTo-Brush $t.Dim
  $sub.TextTrimming = 'CharacterEllipsis'
  $sp.Children.Add($sub) | Out-Null

  $body = New-Object System.Windows.Controls.Grid
  $body.Height = 22; $body.Margin = [System.Windows.Thickness]::new(0,5,0,0)
  $body.VerticalAlignment = 'Bottom'
  $sp.Children.Add($body) | Out-Null

  $card.Child = $sp
  return [pscustomobject]@{ Root=$card; Value=$val; Sub=$sub; Body=$body; Accent=$Accent; Spark=$null }
}

function Add-Sparkline($tile) {
  $poly = New-Object System.Windows.Shapes.Polyline
  $poly.Stroke = ConvertTo-Brush $tile.Accent
  $poly.StrokeThickness = 1.7
  $poly.StrokeLineJoin = 'Round'
  $g = New-Object System.Windows.Media.Effects.DropShadowEffect
  $g.ShadowDepth = 0; $g.BlurRadius = 5; $g.Color = (ConvertTo-Color $tile.Accent); $g.Opacity = 0.5
  $poly.Effect = $g
  $tile.Body.Children.Add($poly) | Out-Null
  $tile | Add-Member -NotePropertyName Spark -NotePropertyValue $poly -Force
  return $poly
}

function Update-Sparkline($poly, $data, [double]$w = 128, [double]$h = 20) {
  if ($null -eq $poly -or $data.Count -lt 2) { return }
  $maxV = 0.0
  foreach ($d in $data) { if ($d -gt $maxV) { $maxV = $d } }
  if ($maxV -le 0) { $maxV = 1.0 }
  $n = $data.Count
  $pts = New-Object System.Windows.Media.PointCollection
  for ($i = 0; $i -lt $n; $i++) {
    $x = if ($n -gt 1) { ($i / ($n - 1.0)) * $w } else { 0 }
    $y = $h - (($data[$i] / $maxV) * ($h - 2)) - 1
    $pts.Add((New-Object System.Windows.Point($x, $y)))
  }
  $poly.Points = $pts
}

# Labelled bar row: [label] [====track/fill====] [count]. Reused for methods/status/product.
function New-BarRow([string]$Label, [string]$ColorHex, [double]$LabelW = 58, [double]$CountW = 72) {
  $t = $global:ChilloutTheme
  $g = New-Object System.Windows.Controls.Grid
  $g.Margin = [System.Windows.Thickness]::new(0,0,0,7)
  $cL = New-Object System.Windows.Controls.ColumnDefinition; $cL.Width = ([string]$LabelW)
  $cB = New-Object System.Windows.Controls.ColumnDefinition; $cB.Width = '*'
  $cN = New-Object System.Windows.Controls.ColumnDefinition; $cN.Width = ([string]$CountW)
  $g.ColumnDefinitions.Add($cL); $g.ColumnDefinitions.Add($cB); $g.ColumnDefinitions.Add($cN)
  $lbl = New-Object System.Windows.Controls.TextBlock
  $lbl.Text = $Label; $lbl.FontSize = 11; $lbl.FontWeight = 'SemiBold'
  $lbl.FontFamily = New-Object System.Windows.Media.FontFamily 'Cascadia Mono, Consolas'
  $lbl.Foreground = ConvertTo-Brush $ColorHex; $lbl.VerticalAlignment = 'Center'
  [System.Windows.Controls.Grid]::SetColumn($lbl, 0); $g.Children.Add($lbl) | Out-Null
  $track = New-Object System.Windows.Controls.Border
  $track.Height = 7; $track.CornerRadius = [System.Windows.CornerRadius]::new(4)
  $track.Background = ConvertTo-Brush $t.TrackBg; $track.HorizontalAlignment = 'Stretch'
  $track.VerticalAlignment = 'Center'; $track.Margin = [System.Windows.Thickness]::new(2,0,8,0)
  $bar = New-Object System.Windows.Controls.Border
  $bar.Height = 7; $bar.CornerRadius = [System.Windows.CornerRadius]::new(4)
  $bar.Background = ConvertTo-Brush $ColorHex; $bar.HorizontalAlignment = 'Left'; $bar.Width = 0
  $bg = New-Object System.Windows.Media.Effects.DropShadowEffect
  $bg.ShadowDepth = 0; $bg.BlurRadius = 6; $bg.Color = (ConvertTo-Color $ColorHex); $bg.Opacity = 0.45
  $bar.Effect = $bg
  $track.Child = $bar
  [System.Windows.Controls.Grid]::SetColumn($track, 1); $g.Children.Add($track) | Out-Null
  $cnt = New-Object System.Windows.Controls.TextBlock
  $cnt.Text = '0'; $cnt.FontSize = 11; $cnt.Foreground = ConvertTo-Brush '#AFBCCC'
  $cnt.FontFamily = New-Object System.Windows.Media.FontFamily 'Cascadia Mono, Consolas'
  $cnt.VerticalAlignment = 'Center'; $cnt.HorizontalAlignment = 'Right'
  [System.Windows.Controls.Grid]::SetColumn($cnt, 2); $g.Children.Add($cnt) | Out-Null
  return [pscustomobject]@{ Root=$g; Bar=$bar; Track=$track; Count=$cnt }
}

function Set-BarRow($row, [int]$Value, [int]$Max, [string]$Text) {
  if ($Max -le 0) { $Max = 1 }
  $full = [math]::Max(0.0, $row.Track.ActualWidth - 2)
  if ($full -le 0) { $full = 140 }
  Animate-Double $row.Bar ([System.Windows.FrameworkElement]::WidthProperty) (($Value / [double]$Max) * $full) 450
  $row.Count.Text = $Text
}

# Terminal-style section header e.g. "// AUDIENCE".
function New-SectionHeader([string]$Title, [double]$Width = 0) {
  $t = $global:ChilloutTheme
  $b = New-Object System.Windows.Controls.Border
  $b.Margin = [System.Windows.Thickness]::new(5, 10, 5, 3)
  if ($Width -gt 0) { $b.Width = $Width }
  $sp = New-Object System.Windows.Controls.StackPanel; $sp.Orientation = 'Horizontal'
  $slash = New-Object System.Windows.Controls.TextBlock
  $slash.Text = '// '; $slash.FontWeight = 'Bold'; $slash.FontSize = 12
  $slash.FontFamily = New-Object System.Windows.Media.FontFamily 'Cascadia Mono, Consolas'
  $slash.Foreground = ConvertTo-Brush $t.Accent2
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $Title.ToUpper(); $tb.FontWeight = 'SemiBold'; $tb.FontSize = 12
  $tb.FontFamily = New-Object System.Windows.Media.FontFamily 'Cascadia Mono, Consolas'
  $tb.Foreground = ConvertTo-Brush $t.Sub
  $sp.Children.Add($slash) | Out-Null; $sp.Children.Add($tb) | Out-Null
  $b.Child = $sp
  return $b
}

# Key/value resource line for resource & infra panels.
function New-ResLine([string]$Accent) {
  $g = New-Object System.Windows.Controls.Grid
  $g.Margin = [System.Windows.Thickness]::new(0,0,0,6)
  $cA = New-Object System.Windows.Controls.ColumnDefinition; $cA.Width = '128'
  $cB = New-Object System.Windows.Controls.ColumnDefinition; $cB.Width = '*'
  $g.ColumnDefinitions.Add($cA); $g.ColumnDefinitions.Add($cB)
  $k = New-Object System.Windows.Controls.TextBlock
  $k.FontSize = 11.5; $k.Foreground = ConvertTo-Brush $Accent; $k.FontWeight = 'SemiBold'
  [System.Windows.Controls.Grid]::SetColumn($k, 0); $g.Children.Add($k) | Out-Null
  $v = New-Object System.Windows.Controls.TextBlock
  $v.FontSize = 11.5; $v.Foreground = ConvertTo-Brush '#C2CDDA'; $v.TextTrimming = 'CharacterEllipsis'
  $v.FontFamily = New-Object System.Windows.Media.FontFamily 'Cascadia Mono, Consolas'
  [System.Windows.Controls.Grid]::SetColumn($v, 1); $g.Children.Add($v) | Out-Null
  return [pscustomobject]@{ Root=$g; Key=$k; Val=$v }
}

# Programmatic Tool/Term CTA button (when you want to build buttons in code).
function New-CgToolButton([string]$Text, [string]$ToolTip = '', [string]$StyleKey = 'Tool', $StyleSource = $null) {
  $btn = New-Object System.Windows.Controls.Button
  $btn.Content = $Text
  if ($ToolTip) { $btn.ToolTip = $ToolTip }
  if ($StyleSource -and $StyleSource.Resources.Contains($StyleKey)) { $btn.Style = $StyleSource.Resources[$StyleKey] }
  return $btn
}
