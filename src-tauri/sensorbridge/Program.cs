using System.Globalization;
using System.Text.Json;
using LibreHardwareMonitor.Hardware;

// ---------------------------------------------------------------------------
// sensorbridge: streams hardware sensor readings as newline-delimited JSON.
//
// Protocol (one compact JSON object per line, stdout, flushed):
//   {"type":"specs", ...}      emitted once at startup
//   {"type":"sample", ...}     emitted every interval (default 2000ms)
//   {"type":"error","message"} on fatal init failure
//
// Control (stdin, one command per line):
//   interval <ms>   change the sampling interval live (>= 500). The app runs us at
//                   2s only while something is actually viewing system stats and
//                   at 10s otherwise: each sample polls every sensor chip (SuperIO,
//                   SMBus, SMART), which is not free on a machine that is gaming or
//                   streaming.
//
// Numeric sensor fields are null when the sensor is unavailable on this
// machine / privilege level, so the UI can show "—" gracefully.
// ---------------------------------------------------------------------------

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var stdout = Console.Out;
foreach (var a in args)
{
    if (a.StartsWith("--interval=", StringComparison.OrdinalIgnoreCase) &&
        int.TryParse(a.Substring("--interval=".Length), out var ms) && ms >= 500)
        Cfg.IntervalMs = ms;
}

// Live interval changes from the parent (see the protocol above). Wakes the
// sampling loop immediately so a newly opened System page gets fresh data now.
new Thread(() =>
{
    try
    {
        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 2 && parts[0] == "interval" &&
                int.TryParse(parts[1], out var ms) && ms >= 500)
            {
                Cfg.IntervalMs = ms;
                Cfg.Wake.Set();
            }
        }
    }
    catch { /* stdin gone — keep sampling at the last interval */ }
}) { IsBackground = true, Name = "stdin-control" }.Start();

RemoveLegacyDriver();

var computer = new Computer
{
    IsCpuEnabled = true,
    IsGpuEnabled = true,
    IsMemoryEnabled = true,
    IsMotherboardEnabled = true,
    IsStorageEnabled = true,
};

try
{
    computer.Open();
}
catch (Exception ex)
{
    WriteLine(JsonSerializer.Serialize(new { type = "error", message = ex.Message }));
    return;
}

var visitor = new UpdateVisitor();

// One-time specs line (hardware names / counts).
try
{
    computer.Accept(visitor);
    WriteLine(JsonSerializer.Serialize(BuildSpecs(computer)));
}
catch { /* specs are best-effort */ }

// Graceful shutdown when the parent process exits / closes our stdin.
AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { computer.Close(); } catch { } };

while (true)
{
    try
    {
        computer.Accept(visitor);
        WriteLine(JsonSerializer.Serialize(BuildSample(computer)));
    }
    catch (Exception ex)
    {
        WriteLine(JsonSerializer.Serialize(new { type = "sample", error = ex.Message }));
    }

    // Stop if stdout is gone (parent exited).
    if (Console.Out.GetType() == typeof(TextWriter) /* never true */) break;
    Cfg.Wake.WaitOne(Cfg.IntervalMs);
}

void WriteLine(string s)
{
    try { stdout.Write(s); stdout.Write('\n'); stdout.Flush(); }
    catch { Environment.Exit(0); }
}

object BuildSpecs(Computer c)
{
    string? cpuName = null;
    var gpus = new List<string>();
    string? motherboard = null;
    foreach (var hw in c.Hardware)
    {
        switch (hw.HardwareType)
        {
            case HardwareType.Cpu:
                cpuName ??= hw.Name;
                break;
            case HardwareType.GpuNvidia:
            case HardwareType.GpuAmd:
            case HardwareType.GpuIntel:
                gpus.Add(hw.Name);
                break;
            case HardwareType.Motherboard:
                motherboard ??= hw.Name;
                break;
        }
    }
    // CPU temperature/power, SuperIO and SMBus readings need the PawnIO driver
    // (installed separately, e.g. `winget install namazso.PawnIO`); without it those
    // fields stay null and GPU, load and NVMe readings still work.
    bool pawnIo = false;
    string? pawnIoVersion = null;
    try
    {
        pawnIo = LibreHardwareMonitor.PawnIo.PawnIo.IsInstalled;
        pawnIoVersion = LibreHardwareMonitor.PawnIo.PawnIo.Version?.ToString();
    }
    catch { }
    return new
    {
        type = "specs",
        cpuName,
        gpuNames = gpus,
        motherboard,
        pawnIo,
        pawnIoVersion,
    };
}

// LibreHardwareMonitorLib up to 0.9.4 installed WinRing0 1.2 (CVE-2020-14979,
// flagged by Defender as HackTool:Win32/Winring0) as the kernel service
// "R0<exe name>" from "<exe name>.sys" beside this exe, at every start. 0.9.6 uses
// the signed PawnIO driver instead, so take down what the old builds left behind.
// Cheap when there is nothing to do: one registry lookup. Needs the elevated
// parent the app already is; unelevated it just tries again next start.
static void RemoveLegacyDriver()
{
    try
    {
        var exe = Environment.ProcessPath;
        if (exe is null) return;
        var service = "R0" + Path.GetFileNameWithoutExtension(exe);
        using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{service}"))
        {
            if (key is not null)
            {
                Sc($"stop {service}");
                Sc($"delete {service}");
            }
        }
        var sys = Path.ChangeExtension(exe, ".sys");
        if (File.Exists(sys)) File.Delete(sys);
    }
    catch { /* still loaded or not elevated: next start */ }

    static void Sc(string args)
    {
        using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("sc.exe", args)
        {
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
        });
        p?.WaitForExit(5000);
    }
}

object BuildSample(Computer c)
{
    double? cpuLoad = null, cpuTemp = null, cpuClock = null, cpuPower = null;
    double? gpuLoad = null, gpuTemp = null, gpuClock = null, gpuPower = null,
            gpuMemUsed = null, gpuMemTotal = null;
    double? ramLoad = null, ramUsed = null, ramAvail = null, ramTemp = null;
    double? diskActivity = null, diskTemp = null;
    string? gpuName = null;

    foreach (var hw in c.Hardware)
    {
        switch (hw.HardwareType)
        {
            case HardwareType.Cpu:
                foreach (var s in hw.Sensors)
                {
                    var v = s.Value;
                    if (v is null) continue;
                    switch (s.SensorType)
                    {
                        case SensorType.Load when s.Name.Contains("CPU Total"):
                            cpuLoad = v; break;
                        case SensorType.Temperature when s.Name.Contains("Package"):
                            cpuTemp = v; break;
                        case SensorType.Temperature when cpuTemp is null && s.Name.Contains("Core"):
                            cpuTemp = Math.Max(cpuTemp ?? 0, v.Value); break;
                        case SensorType.Clock when s.Name.Contains("Core") && (cpuClock is null || v > cpuClock):
                            cpuClock = v; break;
                        case SensorType.Power when s.Name.Contains("Package"):
                            cpuPower = v; break;
                    }
                }
                break;

            case HardwareType.GpuNvidia:
            case HardwareType.GpuAmd:
            case HardwareType.GpuIntel:
                gpuName ??= hw.Name;
                foreach (var s in hw.Sensors)
                {
                    var v = s.Value;
                    if (v is null) continue;
                    switch (s.SensorType)
                    {
                        case SensorType.Load when s.Name.Contains("GPU Core"):
                            gpuLoad = v; break;
                        case SensorType.Temperature when s.Name.Contains("GPU Core"):
                            gpuTemp = v; break;
                        case SensorType.Temperature when gpuTemp is null && s.Name.Contains("GPU"):
                            gpuTemp = v; break;
                        case SensorType.Clock when s.Name.Contains("GPU Core"):
                            gpuClock = v; break;
                        case SensorType.Power when s.Name.Contains("GPU Package") || s.Name.Contains("GPU Power"):
                            gpuPower = v; break;
                        case SensorType.SmallData when s.Name.Contains("GPU Memory Used"):
                            gpuMemUsed = v; break;
                        case SensorType.SmallData when s.Name.Contains("GPU Memory Total"):
                            gpuMemTotal = v; break;
                    }
                }
                break;

            case HardwareType.Memory:
                foreach (var s in hw.Sensors)
                {
                    var v = s.Value;
                    if (v is null) continue;
                    switch (s.SensorType)
                    {
                        case SensorType.Load when s.Name.Contains("Memory") && !s.Name.Contains("Virtual"):
                            ramLoad = v; break;
                        case SensorType.Data when s.Name.Contains("Memory Used") && !s.Name.Contains("Virtual"):
                            ramUsed = v; break;
                        case SensorType.Data when s.Name.Contains("Memory Available") && !s.Name.Contains("Virtual"):
                            ramAvail = v; break;
                        case SensorType.Temperature:
                            ramTemp = Math.Max(ramTemp ?? 0, v.Value); break;
                    }
                }
                break;

            case HardwareType.Storage:
                foreach (var s in hw.Sensors)
                {
                    var v = s.Value;
                    if (v is null) continue;
                    switch (s.SensorType)
                    {
                        // Busiest drive drives the system "disk activity" line.
                        case SensorType.Load when s.Name.Contains("Total Activity"):
                            diskActivity = Math.Max(diskActivity ?? 0, v.Value); break;
                        case SensorType.Temperature when diskTemp is null || v > diskTemp:
                            diskTemp = v; break;
                    }
                }
                break;
        }
    }

    // RAM temperature can live under the memory node or a motherboard SMBus
    // sub-device depending on the board — scan broadly for it.
    if (ramTemp is null)
        ramTemp = FindMemoryTemp(c.Hardware);

    return new
    {
        type = "sample",
        cpuLoad,
        cpuTemp,
        cpuClock,
        cpuPower,
        gpuName,
        gpuLoad,
        gpuTemp,
        gpuClock,
        gpuPower,
        gpuMemUsed,
        gpuMemTotal,
        ramLoad,
        ramUsed,
        ramAvail,
        ramTemp,
        diskActivity,
        diskTemp,
    };
}

// Recursively hunt for a DIMM/DRAM/SPD temperature across hardware + sub-hardware.
static double? FindMemoryTemp(IEnumerable<IHardware> hardwares)
{
    double? t = null;
    foreach (var hw in hardwares)
    {
        bool isMem = hw.HardwareType == HardwareType.Memory;
        foreach (var s in hw.Sensors)
        {
            if (s.SensorType != SensorType.Temperature || s.Value is null) continue;
            var n = s.Name.ToLowerInvariant();
            if (isMem || n.Contains("dimm") || n.Contains("dram") || n.Contains("spd") ||
                (n.Contains("memory") && !n.Contains("gpu")))
                t = Math.Max(t ?? 0, s.Value.Value);
        }
        var sub = FindMemoryTemp(hw.SubHardware);
        if (sub is not null) t = Math.Max(t ?? 0, sub.Value);
    }
    return t;
}

// Updates every hardware node (and sub-hardware) before reading sensors.
static class Cfg
{
    public static volatile int IntervalMs = 2000;
    public static readonly AutoResetEvent Wake = new(false);
}

sealed class UpdateVisitor : IVisitor
{
    // DIMM temperatures come over the SMBus (the DDR5 SPD hub), a bus shared with
    // the BIOS and RGB tools, one transaction per DIMM per read. They move slowly.
    static readonly TimeSpan MemoryEvery = TimeSpan.FromSeconds(60);
    readonly Dictionary<IHardware, DateTime> _lastMemory = new();

    public void VisitComputer(IComputer computer) => computer.Traverse(this);
    public void VisitHardware(IHardware hardware)
    {
        if (Skip(hardware)) return;
        hardware.Update();
        foreach (var sub in hardware.SubHardware) sub.Accept(this);
    }

    bool Skip(IHardware hardware)
    {
        // A spinning disk: every update is a SMART query, which spins it up from
        // standby (the SMR data drives on the dev PC woke every 2–10 s). Its
        // activity and temperature are left out; SSD and NVMe readings stay.
        if (hardware is LibreHardwareMonitor.Hardware.Storage.StorageDevice d &&
            !d.Storage.IsSSD && !d.Storage.IsNVMe)
            return true;
        if (hardware.HardwareType == HardwareType.Memory)
        {
            var now = DateTime.UtcNow;
            if (_lastMemory.TryGetValue(hardware, out var last) && now - last < MemoryEvery)
                return true;
            _lastMemory[hardware] = now;
        }
        return false;
    }
    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}
