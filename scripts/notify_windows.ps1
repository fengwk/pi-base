param(
  [ValidateSet('notify', 'jump')]
  [string]$Mode = 'notify',

  [string]$TitleBase64 = '',

  [string]$BodyBase64 = '',

  [string]$IconPathBase64 = '',

  [string]$WslDistroBase64 = '',

  [string]$WslNotifyScriptBase64 = '',

  [string]$TmuxTargetBase64 = '',

  [string]$TmuxClientTtyBase64 = '',

  [string]$WtSessionBase64 = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class PiWindowsNotify {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NOTIFYICONDATA {
    public uint cbSize;
    public IntPtr hWnd;
    public uint uID;
    public uint uFlags;
    public uint uCallbackMessage;
    public IntPtr hIcon;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
    public string szTip;
    public uint dwState;
    public uint dwStateMask;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
    public string szInfo;
    public uint uTimeoutOrVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
    public string szInfoTitle;
    public uint dwInfoFlags;
    public Guid guidItem;
    public IntPtr hBalloonIcon;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  public static extern bool SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);

  public const uint NIM_ADD = 0x00000000;
  public const uint NIM_MODIFY = 0x00000001;
  public const uint NIM_DELETE = 0x00000002;
  public const uint NIM_SETVERSION = 0x00000004;

  public const uint NIF_MESSAGE = 0x00000001;
  public const uint NIF_ICON = 0x00000002;
  public const uint NIF_TIP = 0x00000004;
  public const uint NIF_INFO = 0x00000010;

  public const uint NIIF_USER = 0x00000004;
  public const uint NIIF_LARGE_ICON = 0x00000020;

  public const uint NOTIFYICON_VERSION_4 = 4;
  public const uint GA_ROOT = 2;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint WM_USER = 0x0400;
  public const uint WM_APP = 0x8000;
  public const int NIN_SELECT = 0x0400;
  public const int NIN_BALLOONUSERCLICK = 0x0405;
}

public class PiNotifyWindow : Form {
  public int CallbackMessage;
  public bool Clicked;

  protected override void WndProc(ref Message m) {
    if (m.Msg == CallbackMessage) {
      int callbackCode = m.LParam.ToInt32() & 0xFFFF;
      if (callbackCode == PiWindowsNotify.NIN_BALLOONUSERCLICK || callbackCode == PiWindowsNotify.NIN_SELECT) {
        Clicked = true;
      }
    }

    base.WndProc(ref m);
  }
}
"@

function Decode-Base64Utf8([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }

  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

function Limit-Text([string]$Value, [int]$MaxLength) {
  if ([string]::IsNullOrEmpty($Value)) {
    return ''
  }

  if ($Value.Length -le $MaxLength) {
    return $Value
  }

  return $Value.Substring(0, $MaxLength)
}

function Get-RootWindow([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) {
    return [IntPtr]::Zero
  }

  return [PiWindowsNotify]::GetAncestor($Handle, [PiWindowsNotify]::GA_ROOT)
}

function Get-ForegroundRootWindow() {
  return Get-RootWindow ([PiWindowsNotify]::GetForegroundWindow())
}

function Test-IsForegroundWindow([IntPtr]$ExpectedHandle) {
  if ($ExpectedHandle -eq [IntPtr]::Zero) {
    return $false
  }

  return (Get-ForegroundRootWindow) -eq $ExpectedHandle
}

function Wait-ForegroundWindow([IntPtr]$ExpectedHandle, [int]$TimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-IsForegroundWindow $ExpectedHandle) {
      return $true
    }
    Start-Sleep -Milliseconds 50
  }

  return (Test-IsForegroundWindow $ExpectedHandle)
}

function Resolve-RestoreWindow([IntPtr]$OriginRootWindow, [string]$WtSession) {
  if (-not [string]::IsNullOrWhiteSpace($WtSession)) {
    try {
      $terminalWindows = @(Get-Process -Name WindowsTerminal -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 })
      if ($terminalWindows.Count -eq 1) {
        return [IntPtr]$terminalWindows[0].MainWindowHandle
      }
    } catch {
      # ignore and fallback to origin window
    }
  }

  return $OriginRootWindow
}

function Invoke-WindowActivation([IntPtr]$WindowHandle, [uint32]$TargetPid, [uint32]$TargetThread) {
  if ($WindowHandle -eq [IntPtr]::Zero -or -not [PiWindowsNotify]::IsWindow($WindowHandle)) {
    return $false
  }

  $shell = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
  } catch {
    $shell = $null
  }

  $foregroundWindow = [PiWindowsNotify]::GetForegroundWindow()
  $foregroundPid = 0
  $foregroundThread = 0
  if ($foregroundWindow -ne [IntPtr]::Zero) {
    $foregroundThread = [PiWindowsNotify]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundPid)
  }

  $currentThread = [PiWindowsNotify]::GetCurrentThreadId()
  $attachedForeground = $false
  $attachedTarget = $false

  try {
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
      $attachedForeground = [PiWindowsNotify]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }

    if ($TargetThread -ne 0 -and $TargetThread -ne $currentThread) {
      $attachedTarget = [PiWindowsNotify]::AttachThreadInput($currentThread, $TargetThread, $true)
    }

    if ([PiWindowsNotify]::IsIconic($WindowHandle)) {
      [PiWindowsNotify]::ShowWindowAsync($WindowHandle, 9) | Out-Null
    } else {
      [PiWindowsNotify]::ShowWindowAsync($WindowHandle, 5) | Out-Null
    }

    [PiWindowsNotify]::BringWindowToTop($WindowHandle) | Out-Null
    [PiWindowsNotify]::SetWindowPos(
      $WindowHandle,
      [PiWindowsNotify]::HWND_TOPMOST,
      0,
      0,
      0,
      0,
      [PiWindowsNotify]::SWP_NOMOVE -bor [PiWindowsNotify]::SWP_NOSIZE -bor [PiWindowsNotify]::SWP_SHOWWINDOW
    ) | Out-Null
    [PiWindowsNotify]::SetWindowPos(
      $WindowHandle,
      [PiWindowsNotify]::HWND_NOTOPMOST,
      0,
      0,
      0,
      0,
      [PiWindowsNotify]::SWP_NOMOVE -bor [PiWindowsNotify]::SWP_NOSIZE -bor [PiWindowsNotify]::SWP_SHOWWINDOW
    ) | Out-Null

    if ($shell -ne $null) {
      $shell.SendKeys('%')
      Start-Sleep -Milliseconds 60
    }

    [PiWindowsNotify]::SetForegroundWindow($WindowHandle) | Out-Null
    if (Wait-ForegroundWindow $WindowHandle 300) {
      return $true
    }

    if ($shell -ne $null -and $TargetPid -ne 0) {
      try {
        $shell.AppActivate([int]$TargetPid) | Out-Null
        if (Wait-ForegroundWindow $WindowHandle 500) {
          return $true
        }
      } catch {
        # ignore and continue fallback flow
      }
    }

    [PiWindowsNotify]::SwitchToThisWindow($WindowHandle, $true) | Out-Null
    return (Wait-ForegroundWindow $WindowHandle 500)
  } finally {
    if ($attachedTarget) {
      [PiWindowsNotify]::AttachThreadInput($currentThread, $TargetThread, $false) | Out-Null
    }
    if ($attachedForeground) {
      [PiWindowsNotify]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null
    }
  }
}

function Invoke-WslJumpCallback([string]$Distro, [string]$NotifyScript, [string]$TmuxTarget, [string]$TmuxClientTty) {
  if ([string]::IsNullOrWhiteSpace($Distro) -or [string]::IsNullOrWhiteSpace($NotifyScript) -or [string]::IsNullOrWhiteSpace($TmuxTarget)) {
    return 0
  }

  try {
    Start-Process -FilePath 'wsl.exe' -ArgumentList @(
      '-d', $Distro,
      '--',
      '/usr/bin/env',
      ("PI_NOTIFY_TMUX_TARGET={0}" -f $TmuxTarget),
      ("PI_NOTIFY_TMUX_CLIENT_TTY={0}" -f $TmuxClientTty),
      '/bin/bash',
      $NotifyScript,
      'jump'
    ) -WindowStyle Hidden | Out-Null
    return 0
  } catch {
    return 1
  }
}

function Start-JumpWorker(
  [string]$WslDistroBase64,
  [string]$WslNotifyScriptBase64,
  [string]$TmuxTargetBase64,
  [string]$TmuxClientTtyBase64,
  [string]$WtSessionBase64
) {
  if ([string]::IsNullOrWhiteSpace($PSCommandPath)) {
    return 1
  }

  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile',
      '-Sta',
      '-ExecutionPolicy', 'Bypass',
      '-File', $PSCommandPath,
      '-Mode', 'jump',
      '-WslDistroBase64', $WslDistroBase64,
      '-WslNotifyScriptBase64', $WslNotifyScriptBase64,
      '-TmuxTargetBase64', $TmuxTargetBase64,
      '-TmuxClientTtyBase64', $TmuxClientTtyBase64,
      '-WtSessionBase64', $WtSessionBase64
    ) -WindowStyle Hidden | Out-Null
    return 0
  } catch {
    return 1
  }
}

if ($Mode -eq 'jump') {
  $wslDistro = (Decode-Base64Utf8 $WslDistroBase64).Trim()
  $wslNotifyScript = (Decode-Base64Utf8 $WslNotifyScriptBase64).Trim()
  $tmuxTarget = (Decode-Base64Utf8 $TmuxTargetBase64).Trim()
  $tmuxClientTty = (Decode-Base64Utf8 $TmuxClientTtyBase64).Trim()
  $wtSession = (Decode-Base64Utf8 $WtSessionBase64).Trim()

  $originWindow = [PiWindowsNotify]::GetForegroundWindow()
  $originRootWindow = Get-RootWindow $originWindow
  $restoreWindow = Resolve-RestoreWindow $originRootWindow $wtSession
  $restorePid = 0
  $restoreThread = 0
  if ($restoreWindow -ne [IntPtr]::Zero) {
    $restoreThread = [PiWindowsNotify]::GetWindowThreadProcessId($restoreWindow, [ref]$restorePid)
  }

  if ($restoreWindow -ne [IntPtr]::Zero -and [PiWindowsNotify]::IsWindow($restoreWindow)) {
    Invoke-WindowActivation $restoreWindow $restorePid $restoreThread | Out-Null
  }

  exit (Invoke-WslJumpCallback $wslDistro $wslNotifyScript $tmuxTarget $tmuxClientTty)
}

$title = Limit-Text (Decode-Base64Utf8 $TitleBase64).Trim() 63
$body = Limit-Text (Decode-Base64Utf8 $BodyBase64).Trim() 255
$iconPath = (Decode-Base64Utf8 $IconPathBase64).Trim()

$form = $null
$bitmap = $null
$iconHandle = [IntPtr]::Zero
$nid = New-Object PiWindowsNotify+NOTIFYICONDATA

try {
  $form = New-Object PiNotifyWindow
  $form.ShowInTaskbar = $false
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
  $form.Opacity = 0
  $form.CallbackMessage = [int]([PiWindowsNotify]::WM_APP + 101)
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()

  $nid.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][PiWindowsNotify+NOTIFYICONDATA])
  $nid.hWnd = $form.Handle
  $nid.uID = 4097
  $nid.uFlags = [PiWindowsNotify]::NIF_MESSAGE -bor [PiWindowsNotify]::NIF_ICON -bor [PiWindowsNotify]::NIF_TIP
  $nid.uCallbackMessage = [uint32]$form.CallbackMessage
  $nid.szTip = 'Pi'

  if (-not [string]::IsNullOrWhiteSpace($iconPath) -and (Test-Path -LiteralPath $iconPath)) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($iconPath)
    $iconHandle = $bitmap.GetHicon()
    $nid.hIcon = $iconHandle
  } else {
    $nid.hIcon = [System.Drawing.SystemIcons]::Application.Handle
  }

  if (-not [PiWindowsNotify]::Shell_NotifyIcon([PiWindowsNotify]::NIM_ADD, [ref]$nid)) {
    throw 'Shell_NotifyIcon NIM_ADD failed.'
  }

  $nid.uTimeoutOrVersion = [PiWindowsNotify]::NOTIFYICON_VERSION_4
  [PiWindowsNotify]::Shell_NotifyIcon([PiWindowsNotify]::NIM_SETVERSION, [ref]$nid) | Out-Null

  $nid.uFlags = [PiWindowsNotify]::NIF_INFO
  $nid.szInfoTitle = $title
  $nid.szInfo = $body
  $nid.dwInfoFlags = [PiWindowsNotify]::NIIF_USER -bor [PiWindowsNotify]::NIIF_LARGE_ICON
  $nid.hBalloonIcon = $nid.hIcon

  if (-not [PiWindowsNotify]::Shell_NotifyIcon([PiWindowsNotify]::NIM_MODIFY, [ref]$nid)) {
    throw 'Shell_NotifyIcon NIM_MODIFY failed.'
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not $form.Clicked -and [DateTime]::UtcNow -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
  }

  if (-not $form.Clicked) {
    exit 0
  }

  exit (Start-JumpWorker $WslDistroBase64 $WslNotifyScriptBase64 $TmuxTargetBase64 $TmuxClientTtyBase64 $WtSessionBase64)
} catch {
  exit 1
} finally {
  if ($nid.hWnd -ne [IntPtr]::Zero) {
    [PiWindowsNotify]::Shell_NotifyIcon([PiWindowsNotify]::NIM_DELETE, [ref]$nid) | Out-Null
  }
  if ($form -ne $null) {
    $form.Close()
    $form.Dispose()
  }
  if ($bitmap -ne $null) {
    $bitmap.Dispose()
  }
  if ($iconHandle -ne [IntPtr]::Zero) {
    [PiWindowsNotify]::DestroyIcon($iconHandle) | Out-Null
  }
}
