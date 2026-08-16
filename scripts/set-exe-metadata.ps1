param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$Version
)

<#
  Gives the packaged executable its own identity.

  Without this the binary is still a copy of node.exe in every way a user can
  see: Task Manager lists it as "Node.js JavaScript Runtime", Explorer shows the
  Node icon, and -- worst of all -- the Windows Firewall prompt asks whether to
  allow "Node.js JavaScript Runtime" onto the network. Nobody should be asked to
  make a security decision about a program whose name has nothing to do with what
  they installed.

  Uses the resource APIs built into Windows rather than a third-party resource
  editor, matching how the rest of this project talks to Windows.
#>

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ExeMeta {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name,
                                    ushort lang, byte[] data, uint size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool EndUpdateResource(IntPtr update, bool discard);

  const int RT_ICON = 3;
  const int RT_GROUP_ICON = 14;
  const int RT_VERSION = 16;
  const ushort LANG_EN_US = 0x0409;

  // -- version resource ------------------------------------------------------

  static void Pad(BinaryWriter w) {
    while ((w.BaseStream.Position % 4) != 0) w.Write((short)0);
  }

  static void Key(BinaryWriter w, string s) {
    w.Write(Encoding.Unicode.GetBytes(s));
    w.Write((short)0);   // terminating null of the UTF-16 key
  }

  /**
   * Patches a block's wLength once its contents are known.
   *
   * Every node of a version resource stores its own total size, but that size is
   * only knowable after the children are written, so each block is written with
   * a placeholder and backfilled here.
   */
  static void FixLength(BinaryWriter w, long start) {
    long end = w.BaseStream.Position;
    w.BaseStream.Position = start;
    w.Write((ushort)(end - start));
    w.BaseStream.Position = end;
  }

  static void StringEntry(BinaryWriter w, string key, string value) {
    long start = w.BaseStream.Position;
    w.Write((ushort)0);                        // wLength, backfilled
    w.Write((ushort)(value.Length + 1));       // wValueLength, in characters
    w.Write((ushort)1);                        // wType: 1 = text
    Key(w, key);
    Pad(w);
    Key(w, value);
    FixLength(w, start);
    Pad(w);
  }

  static byte[] BuildVersion(Version v, Dictionary<string, string> strings) {
    var ms = new MemoryStream();
    var w = new BinaryWriter(ms);

    long root = ms.Position;
    w.Write((ushort)0);      // wLength, backfilled
    w.Write((ushort)52);     // wValueLength: sizeof(VS_FIXEDFILEINFO)
    w.Write((ushort)0);      // wType: 0 = binary
    Key(w, "VS_VERSION_INFO");
    Pad(w);

    uint ms32 = (uint)((v.Major << 16) | (v.Minor & 0xFFFF));
    uint ls32 = (uint)((v.Build << 16) | (v.Revision & 0xFFFF));
    w.Write((uint)0xFEEF04BD);   // dwSignature
    w.Write((uint)0x00010000);   // dwStrucVersion
    w.Write(ms32); w.Write(ls32);   // file version
    w.Write(ms32); w.Write(ls32);   // product version
    w.Write((uint)0x3F);         // dwFileFlagsMask
    w.Write((uint)0);            // dwFileFlags
    w.Write((uint)0x00040004);   // dwFileOS: VOS_NT_WINDOWS32
    w.Write((uint)1);            // dwFileType: VFT_APP
    w.Write((uint)0);            // dwFileSubtype
    w.Write((uint)0); w.Write((uint)0);   // dwFileDate
    Pad(w);

    long sfi = ms.Position;
    w.Write((ushort)0); w.Write((ushort)0); w.Write((ushort)1);
    Key(w, "StringFileInfo");
    Pad(w);

    long table = ms.Position;
    w.Write((ushort)0); w.Write((ushort)0); w.Write((ushort)1);
    // 0409 = US English, 04B0 = 1200 = UTF-16. The codepage has to match how the
    // strings above are actually encoded or they come back as mojibake.
    Key(w, "040904B0");
    Pad(w);
    foreach (var kv in strings) StringEntry(w, kv.Key, kv.Value);
    FixLength(w, table);
    FixLength(w, sfi);

    long vfi = ms.Position;
    w.Write((ushort)0); w.Write((ushort)0); w.Write((ushort)1);
    Key(w, "VarFileInfo");
    Pad(w);
    long var = ms.Position;
    w.Write((ushort)0); w.Write((ushort)4); w.Write((ushort)0);
    Key(w, "Translation");
    Pad(w);
    w.Write((uint)0x04B00409);   // the same language/codepage pair, as a DWORD
    FixLength(w, var);
    FixLength(w, vfi);
    FixLength(w, root);

    w.Flush();
    return ms.ToArray();
  }

  // -- icon ------------------------------------------------------------------

  /**
   * Icons are stored differently in a .ico file and in a PE.
   *
   * On disk one file holds every frame. In an executable each frame is its own
   * RT_ICON resource, and a single RT_GROUP_ICON lists them by id. So the file
   * is split apart and a directory written to match.
   */
  static void WriteIcon(IntPtr update, string icoPath) {
    var raw = File.ReadAllBytes(icoPath);
    int count = BitConverter.ToUInt16(raw, 4);

    var group = new MemoryStream();
    var gw = new BinaryWriter(group);
    gw.Write((ushort)0); gw.Write((ushort)1); gw.Write((ushort)count);

    for (int i = 0; i < count; i++) {
      int e = 6 + i * 16;
      int size = BitConverter.ToInt32(raw, e + 8);
      int offset = BitConverter.ToInt32(raw, e + 12);
      ushort id = (ushort)(i + 1);

      var frame = new byte[size];
      Array.Copy(raw, offset, frame, 0, size);
      if (!UpdateResource(update, (IntPtr)RT_ICON, (IntPtr)id, LANG_EN_US, frame, (uint)size))
        throw new Exception("UpdateResource failed for icon frame " + id);

      // GRPICONDIRENTRY is the file's entry with the 4-byte offset replaced by a
      // 2-byte resource id -- 14 bytes rather than 16.
      gw.Write(raw, e, 12);
      gw.Write(id);
    }
    gw.Flush();

    var dir = group.ToArray();
    if (!UpdateResource(update, (IntPtr)RT_GROUP_ICON, (IntPtr)1, LANG_EN_US, dir, (uint)dir.Length))
      throw new Exception("UpdateResource failed for the icon directory");
  }

  public static void Apply(string exe, string ico, string version,
                           string productName, string description, string company,
                           string copyright, string originalName) {
    var v = new Version(version);
    if (v.Build < 0) v = new Version(v.Major, v.Minor, 0, 0);
    if (v.Revision < 0) v = new Version(v.Major, v.Minor, v.Build, 0);

    var strings = new Dictionary<string, string> {
      { "CompanyName", company },
      { "FileDescription", description },
      { "FileVersion", v.ToString() },
      { "InternalName", originalName },
      { "LegalCopyright", copyright },
      { "OriginalFilename", originalName },
      { "ProductName", productName },
      { "ProductVersion", v.ToString() },
    };

    // false: keep the resources already present. The packaged app itself lives
    // in one of them -- the injector stores it as a PE resource -- so wiping the
    // table would produce an executable that starts and does nothing.
    IntPtr update = BeginUpdateResource(exe, false);
    if (update == IntPtr.Zero)
      throw new Exception("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());

    try {
      var ver = BuildVersion(v, strings);
      if (!UpdateResource(update, (IntPtr)RT_VERSION, (IntPtr)1, LANG_EN_US, ver, (uint)ver.Length))
        throw new Exception("UpdateResource failed for the version block");
      WriteIcon(update, ico);
    } catch {
      EndUpdateResource(update, true);   // discard
      throw;
    }

    if (!EndUpdateResource(update, false))
      throw new Exception("EndUpdateResource failed: " + Marshal.GetLastWin32Error());
  }
}
'@

[ExeMeta]::Apply(
  (Resolve-Path $Exe).Path,
  (Resolve-Path $IconPath).Path,
  $Version,
  'PC Remote',
  'PC Remote',
  'PC Remote',
  'Free and open source. LAN only.',
  'PCRemote.exe'
)

$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path $Exe).Path)
Write-Output ("    description: " + $info.FileDescription)
Write-Output ("    product:     " + $info.ProductName + " " + $info.ProductVersion)
