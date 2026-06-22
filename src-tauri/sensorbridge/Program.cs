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
// Numeric sensor fields are null when the sensor is unavailable on this
// machine / privilege level, so the UI can show "—" gracefully.
// ---------------------------------------------------------------------------

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var stdout = Console.Out;
int intervalMs = 2000;
foreach (var a in args)
{
    if (a.StartsWith("--interval=", StringComparison.OrdinalIgnoreCase) &&
        int.TryParse(a.Substring("--interval=".Length), out var ms) && ms >= 500)
        intervalMs = ms;
}

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
    Thread.Sleep(intervalMs);
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
    return new
    {
        type = "specs",
        cpuName,
        gpuNames = gpus,
        motherboard,
    };
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
sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);
    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (var sub in hardware.SubHardware) sub.Accept(this);
    }
    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}
