# Owner: Platform/Testing. Phase: P10+. Windows process-tree ownership.
param([string]$RequestJson)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$request = $(if ($RequestJson) { $RequestJson } else { [Console]::In.ReadToEnd() }) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class StorageProcess {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,xsize,ysize,xchars,ychars,fill,flags;
    public short show,reserved2; public IntPtr reserved3,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user,kernel,periodUser,periodKernel;
    public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime,jobTime; public uint flags; public UIntPtr min,max;
    public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limit { public BasicLimit basic; public Io io; public UIntPtr pm,jm,peakp,peakj; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref Limit value,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out Accounting value,int size,IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int value);
  public static string Quote(string value) {
    StringBuilder b=new StringBuilder("\""); int slash=0;
    foreach(char c in value) {
      if(c=='\\') { slash++; continue; }
      if(c=='\"') { b.Append('\\',slash*2+1); b.Append(c); slash=0; continue; }
      b.Append('\\',slash); slash=0; b.Append(c);
    }
    b.Append('\\',slash*2); b.Append('"'); return b.ToString();
  }
  public static long[] Run(string command,string[] args,string cwd) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); ProcessInfo p=new ProcessInfo(); bool started=false;
    if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      Limit limit=new Limit(); limit.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(Limit)))) throw new System.ComponentModel.Win32Exception();
      StringBuilder line=new StringBuilder(Quote(command)); foreach(string arg in args) {line.Append(' ');line.Append(Quote(arg));}
      Startup startup=new Startup(); startup.cb=Marshal.SizeOf(typeof(Startup)); startup.flags=0x100;
      startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
      if(!CreateProcess(command,line,IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,cwd,ref startup,out p)) throw new System.ComponentModel.Win32Exception();
      started=true;
      if(!AssignProcessToJobObject(job,p.process)) throw new System.ComponentModel.Win32Exception();
      if(ResumeThread(p.thread)==0xffffffff) throw new System.ComponentModel.Win32Exception();
      WaitForSingleObject(p.process,0xffffffff); uint code;
      if(!GetExitCodeProcess(p.process,out code)) throw new System.ComponentModel.Win32Exception();
      Accounting accounting;
      if(!QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
      uint remaining=accounting.active;
      if(remaining>0) { TerminateJobObject(job,1); WaitForSingleObject(job,10000); }
      return new long[]{code,remaining,p.pid};
    } finally {
      if(started) { TerminateProcess(p.process,1); CloseHandle(p.thread); CloseHandle(p.process); }
      CloseHandle(job);
    }
  }
}
'@
try {
  $result = [StorageProcess]::Run($request.command, [string[]]$request.args, $request.cwd)
  $receipt = @{exit_status=$result[0];remaining_processes=$result[1];pid=$result[2]}
  if ($request.receipt) { [IO.File]::WriteAllText($request.receipt, ($receipt | ConvertTo-Json -Compress)) }
  if ($result[1] -gt 0) { exit 1 }
  exit $result[0]
} catch {
  $code = if ($_.Exception.InnerException.NativeErrorCode -eq 2) { 'ENOENT' } else { 'workspace_run_process_start_failed' }
  if ($request.receipt) { [IO.File]::WriteAllText($request.receipt, (@{exit_status=1;error=$code} | ConvertTo-Json -Compress)) }
  else { [Console]::Error.WriteLine($code) }
  exit 1
}
