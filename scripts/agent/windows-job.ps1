param([Parameter(Mandatory=$true)][string]$NodePath,
      [Parameter(Mandatory=$true)][string]$RunnerPath,
      [Parameter(Mandatory=$true)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
# Own the job before spawning anything. Its handle is not inheritable; terminating
# this host closes the last handle and kills every member, including MSYS orphans.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;
public static class LedgerForceJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic;
    public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  // Deliberately retained until process teardown, never inherited by a child.
  static IntPtr job;
  public static void Enter() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var info = new Extended();
    info.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info)))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static int Run(string node, string runner, string launch) {
    var start = new ProcessStartInfo(node, "\"" + runner + "\" \"" + launch + "\"");
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    // PowerShell does not expose usable inherited native pipe handles to Process.Start.
    // Forward both streams concurrently so a verbose provider cannot fill either pipe.
    start.RedirectStandardOutput = true;
    start.RedirectStandardError = true;
    start.StandardOutputEncoding = Encoding.UTF8;
    start.StandardErrorEncoding = Encoding.UTF8;
    using (var process = new Process()) {
      process.StartInfo = start;
      process.OutputDataReceived += (sender, e) => { if (e.Data != null) Console.Out.WriteLine(e.Data); };
      process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
      process.Start();
      process.BeginOutputReadLine();
      process.BeginErrorReadLine();
      process.WaitForExit();
      return process.ExitCode;
    }
  }
}
'@
[LedgerForceJob]::Enter()
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Only filesystem paths (Windows forbids embedded quotes), not provider arguments.
$result = [LedgerForceJob]::Run($NodePath, $RunnerPath, $LaunchFile)
[Environment]::Exit($result)
