# Remove the .md UserChoice key (requires admin).
# After removal Windows falls back to HKCU\Software\Classes\.md -> mdreader.Document.
$ErrorActionPreference = 'Stop'
$Log = Join-Path $env:TEMP 'mdreader-reset-userchoice.log'

try {
    $src = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class AssocFix
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LUID_AND_ATTRIBUTES { public long Luid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_PRIVILEGES { public uint Count; public LUID_AND_ATTRIBUTES Privilige0; }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processToken, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool LookupPrivilegeValue(string systemName, string name, out long luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll,
        ref TOKEN_PRIVILEGES newState, uint bufferLength, IntPtr previousState, IntPtr returnLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegDeleteTreeW(IntPtr hKey, string subKey);

    private static readonly IntPtr HKEY_CURRENT_USER = unchecked((IntPtr)0x80000001L);

    private static bool EnablePrivilege(string name)
    {
        IntPtr token;
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x20 | 0x08, out token)) return false;
        long luid;
        if (!LookupPrivilegeValue(null, name, out luid)) return false;
        var tp = new TOKEN_PRIVILEGES { Count = 1, Privilige0 = new LUID_AND_ATTRIBUTES { Luid = luid, Attributes = 0x00000002 } };
        return AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    }

    public static bool ResetUserChoice(string extension)
    {
        // SeRestorePrivilege lets RegDeleteTree bypass the deny-ACL on UserChoice
        EnablePrivilege("SeRestorePrivilege");
        var path = @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\" + extension + @"\UserChoice";
        uint rc = RegDeleteTreeW(HKEY_CURRENT_USER, path);
        return rc == 0 || rc == 2; // 0 = deleted, 2 = not present
    }
}
"@
    Add-Type -TypeDefinition $src
    $null = [AssocFix]::ResetUserChoice('.md')
    Set-Content -Path $Log -Value 'OK'
} catch {
    Set-Content -Path $Log -Value ('FAIL: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace)
}
