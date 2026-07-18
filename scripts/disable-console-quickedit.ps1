# Disable Windows console Quick Edit Mode.
# Without this, clicking the console window freezes the process until Enter is pressed.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ConsoleQuickEdit {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll")]
  static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
  [DllImport("kernel32.dll")]
  static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
  const int STD_INPUT_HANDLE = -10;
  const uint ENABLE_QUICK_EDIT = 0x0040;
  const uint ENABLE_EXTENDED_FLAGS = 0x0080;
  public static void Disable() {
    IntPtr handle = GetStdHandle(STD_INPUT_HANDLE);
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
    uint mode;
    if (!GetConsoleMode(handle, out mode)) return;
    mode &= ~ENABLE_QUICK_EDIT;
    mode |= ENABLE_EXTENDED_FLAGS;
    SetConsoleMode(handle, mode);
  }
}
"@
[ConsoleQuickEdit]::Disable()
