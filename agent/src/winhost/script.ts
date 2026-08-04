/**
 * The PowerShell host that owns all Windows-native work: Core Audio (volume and
 * per-app sessions) and media-key emulation.
 *
 * Embedded as a string rather than shipped as a .ps1 so the `npm run build`
 * single-file agent stays a single file. It is written to a temp path at startup
 * and run with -File, which keeps stdin free for the command loop.
 *
 * Why a long-lived process: `Add-Type` compiles this C# on every process start,
 * measured at ~600ms. Paying that once is fine; paying it per volume change is
 * not, and the brief asks for 100ms-debounced slider drags. Once compiled, a
 * session enumeration costs ~2.2ms and a volume write ~2ms.
 *
 * Protocol: one JSON object per line in each direction.
 *   in   {"id":1,"cmd":"state"}
 *   in   {"id":2,"cmd":"mediaKey","key":"playPause"}
 *   out  {"id":1,"ok":true,"data":{...}}
 *   out  {"ready":true}                     once, after the C# has compiled
 */
export const WIN_HOST_SCRIPT = String.raw`
param([int]$ParentPid = 0, [double]$ParentStartedMs = 0)

$ErrorActionPreference = 'Stop'
# Without this, app names containing non-ASCII characters arrive mangled.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace PcrAudio {

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int clsCtx, IntPtr activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IntPtr props);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, ref Guid ctx);
    int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
    int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    int GetChannelVolumeLevel(uint ch, out float level);
    int GetChannelVolumeLevelScalar(uint ch, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr sessionId, int flags, out IntPtr session);
    int GetSimpleAudioVolume(IntPtr sessionId, int flags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl session);
  }

  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl {
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
    int GetGroupingParam(out Guid group);
    int SetGroupingParam(ref Guid group, ref Guid ctx);
    int RegisterAudioSessionNotification(IntPtr notify);
    int UnregisterAudioSessionNotification(IntPtr notify);
  }

  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
    int GetGroupingParam(out Guid group);
    int SetGroupingParam(ref Guid group, ref Guid ctx);
    int RegisterAudioSessionNotification(IntPtr notify);
    int UnregisterAudioSessionNotification(IntPtr notify);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetProcessId(out uint pid);
    // PreserveSig is required on the methods with no [out] parameter. Without it
    // the marshaller consumes the HRESULT and the declared int return is
    // meaningless -- IsSystemSoundsSession then reports true for every session,
    // which is exactly the bug this comment exists to prevent recurring.
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid ctx);
    int GetMasterVolume(out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }


  /**
   * Media-key emulation for milestone A.
   *
   * keybd_event rather than a bundled nircmd.exe: it is one P/Invoke into
   * user32, needs no third-party binary, and the compiled interop is already
   * being hosted here for Core Audio.
   *
   * These are system-wide hardware keys, exactly what a keyboard's media buttons
   * send, so Windows routes them to whichever app currently owns media playback.
   * That is the whole point of milestone A: it works without knowing what is
   * playing. The flip side is that it is blind -- nothing is reported back, which
   * is why this backend never claims to know the playback status.
   */
  public static class MediaKeys {
    [DllImport("user32.dll")]
    static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;

    public const byte VK_MEDIA_NEXT_TRACK = 0xB0;
    public const byte VK_MEDIA_PREV_TRACK = 0xB1;
    public const byte VK_MEDIA_STOP = 0xB2;
    public const byte VK_MEDIA_PLAY_PAUSE = 0xB3;

    public static void Send(byte vk) {
      // Media keys are extended-key scan codes; without the flag some apps
      // ignore them entirely.
      keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
      keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
  }

  /**
   * Lock, sleep and display-off.
   *
   * P/Invoke rather than shelling out to rundll32: the interop host is already
   * running, so these cost nothing to add, and "rundll32 powrprof.dll,SetSuspendState"
   * is notorious for hibernating instead of sleeping because it mis-parses its
   * arguments. Calling the API directly makes the intent unambiguous.
   *
   * Shutdown and restart are deliberately NOT here — they need the
   * SE_SHUTDOWN_NAME privilege enabled on the process token, and the agent uses
   * Windows' own shutdown.exe for those instead.
   */
  public static class SystemActions {
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool LockWorkStation();

    // BOOLEAN in the Win32 signature is one byte, not the four BOOL uses.
    [DllImport("powrprof.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    static extern bool SetSuspendState(
      [MarshalAs(UnmanagedType.U1)] bool hibernate,
      [MarshalAs(UnmanagedType.U1)] bool forceCritical,
      [MarshalAs(UnmanagedType.U1)] bool disableWakeEvent);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam,
                                            IntPtr lParam, uint flags, uint timeoutMs,
                                            out IntPtr result);

    static readonly IntPtr HWND_BROADCAST = new IntPtr(0xFFFF);
    const uint WM_SYSCOMMAND = 0x0112;
    static readonly IntPtr SC_MONITORPOWER = new IntPtr(0xF170);
    static readonly IntPtr MONITOR_OFF = new IntPtr(2);
    const uint SMTO_ABORTIFHUNG = 0x0002;

    public static bool Lock() { return LockWorkStation(); }

    // hibernate=false so this suspends rather than hibernates; forceCritical=false
    // so applications still get a chance to object.
    public static bool Sleep() { return SetSuspendState(false, false, false); }

    public static bool DisplayOff() {
      IntPtr result;
      // Broadcast, with a timeout: a single hung top-level window must not wedge
      // the interop host, which also serves volume and media.
      IntPtr rc = SendMessageTimeout(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER,
                                     MONITOR_OFF, SMTO_ABORTIFHUNG, 2000, out result);
      return rc != IntPtr.Zero;
    }
  }

  /**
   * Monitor input switching over DDC/CI.
   *
   * Every display exposes a small control channel on its video cable. VCP code
   * 0x60 is "Input Source Select" in the MCCS spec, so writing it is how a
   * monitor is told to switch between DisplayPort, HDMI and so on.
   *
   * Two measured facts shape how the agent uses this:
   *
   *  - Reading the capabilities string costs 2-3.4 SECONDS per monitor. It is
   *    read once and cached; polling it would be unusable.
   *  - Reading the current input costs ~60ms per monitor, so the poll runs on a
   *    slow timer rather than the 1 Hz tick.
   *
   * The "max" value returned alongside the current input is NOT the list of
   * valid inputs. On the Acer here it reports 0x03 while the monitor is actually
   * sitting on 0x11, so trusting it would offer inputs that do not exist and hide
   * the one in use. The capabilities string is the only reliable source.
   */
  public static class Monitors {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR {
      public IntPtr hPhysicalMonitor;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
      public string szDescription;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX {
      public int cbSize;
      public RECT rcMonitor;
      public RECT rcWork;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
      public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DISPLAY_DEVICE {
      public int cb;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]  public string DeviceName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
      public uint StateFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    delegate bool MonitorEnumProc(IntPtr h, IntPtr hdc, IntPtr r, IntPtr d);

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFOEX info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplayDevices(string device, uint devNum, ref DISPLAY_DEVICE dd, uint flags);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, out uint count);
    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint count, [Out] PHYSICAL_MONITOR[] mons);
    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] mons);
    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, out uint type, out uint current, out uint max);
    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool SetVCPFeature(IntPtr h, byte code, uint value);
    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetCapabilitiesStringLength(IntPtr h, out uint len);
    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool CapabilitiesRequestAndCapabilitiesReply(IntPtr h, StringBuilder buf, uint len);

    const byte VCP_INPUT_SOURCE = 0x60;
    /**
     * Luminance. Unlike input source this is a genuine continuous control, so
     * the "max" returned alongside it IS meaningful and is what the percentage
     * is scaled against — monitors do not all use 0-100.
     */
    const byte VCP_BRIGHTNESS = 0x10;
    const uint EDD_GET_DEVICE_INTERFACE_NAME = 1;

    public class Item {
      public string Id;
      public string Device;
      public string Description;
      public string HardwareId;
      public bool Primary;
      public bool HasInput;
      public uint CurrentInput;
      public bool HasBrightness;
      public uint Brightness;
      public uint BrightnessMax;
      public string Capabilities;
      public string Error;
    }

    /**
     * Reads the current input, retrying briefly.
     *
     * A single DDC/CI read failing means very little. The channel is I2C over the
     * video cable and drops requests for mundane reasons — the monitor is busy,
     * another application is mid-conversation with it, the cable is long. Treating
     * one failure as "this monitor cannot be controlled" made the card flicker
     * between working and broken.
     */
    static bool TryReadInput(IntPtr handle, out uint current) {
      uint max;
      return TryReadVcp(handle, VCP_INPUT_SOURCE, out current, out max);
    }

    /** Reads any VCP feature, retrying, and reports its maximum as well. */
    static bool TryReadVcp(IntPtr handle, byte code, out uint current, out uint max) {
      for (int attempt = 0; attempt < 3; attempt++) {
        uint type;
        if (GetVCPFeatureAndVCPFeatureReply(handle, code, out type, out current, out max)) {
          return true;
        }
        if (attempt < 2) System.Threading.Thread.Sleep(60);
      }
      current = 0;
      max = 0;
      return false;
    }

    /**
     * Writes brightness as a percentage of whatever range the monitor reports.
     * Returns the value actually read back, or -1.
     *
     * No settle delay here, unlike an input change: brightness applies instantly
     * and this is driven by a slider, so a 250ms pause per write would make
     * dragging feel broken.
     */
    public static int SetBrightness(string id, uint percent) {
      if (percent > 100) percent = 100;
      foreach (var h in Handles()) {
        var mi = new MONITORINFOEX();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (!GetMonitorInfo(h, ref mi)) continue;

        uint count;
        if (!GetNumberOfPhysicalMonitorsFromHMONITOR(h, out count) || count == 0) continue;
        var mons = new PHYSICAL_MONITOR[count];
        if (!GetPhysicalMonitorsFromHMONITOR(h, count, mons)) continue;

        try {
          for (int i = 0; i < mons.Length; i++) {
            if (mi.szDevice + ":" + i != id) continue;

            uint cur, max;
            if (!TryReadVcp(mons[i].hPhysicalMonitor, VCP_BRIGHTNESS, out cur, out max) || max == 0) return -1;

            uint target = (uint)((percent * max) / 100);
            bool written = false;
            for (int attempt = 0; attempt < 3 && !written; attempt++) {
              written = SetVCPFeature(mons[i].hPhysicalMonitor, VCP_BRIGHTNESS, target);
              if (!written) System.Threading.Thread.Sleep(60);
            }
            if (!written) return -1;
            return (int)((target * 100) / max);
          }
        } finally {
          DestroyPhysicalMonitors(count, mons);
        }
      }
      return -1;
    }

    static List<IntPtr> Handles() {
      var list = new List<IntPtr>();
      MonitorEnumProc cb = delegate(IntPtr h, IntPtr a, IntPtr b, IntPtr c) { list.Add(h); return true; };
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
      return list;
    }

    /**
     * The plug-and-play id behind a display, e.g. ACME1234\5&1a2b3c4d&0&UID256.
     * It is what lets the agent line a monitor up with its EDID name from WMI,
     * since the description Windows hands back is often just "Generic PnP Monitor".
     */
    static string HardwareIdFor(string deviceName) {
      var dd = new DISPLAY_DEVICE();
      dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(deviceName, 0, ref dd, EDD_GET_DEVICE_INTERFACE_NAME)) return "";
      var id = dd.DeviceID ?? "";
      // \\?\DISPLAY#ACME1234#5&1a2b3c4d&0&UID256#{guid}  ->  ACME1234\5&...
      int start = id.IndexOf("DISPLAY#", StringComparison.OrdinalIgnoreCase);
      if (start < 0) return "";
      id = id.Substring(start + 8);
      int hash = id.IndexOf('#');
      if (hash < 0) return "";
      int second = id.IndexOf('#', hash + 1);
      var tail = second < 0 ? id.Substring(hash + 1) : id.Substring(hash + 1, second - hash - 1);
      return id.Substring(0, hash) + "\\" + tail;
    }

    /**
     * @param withCapabilities read the (very slow) capabilities string too. Done
     *        once at startup; the recurring poll passes false.
     */
    public static List<Item> Enumerate(bool withCapabilities) {
      var results = new List<Item>();
      foreach (var h in Handles()) {
        var mi = new MONITORINFOEX();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (!GetMonitorInfo(h, ref mi)) continue;

        uint count;
        if (!GetNumberOfPhysicalMonitorsFromHMONITOR(h, out count) || count == 0) {
          results.Add(new Item { Id = mi.szDevice, Device = mi.szDevice, Error = "no DDC/CI capable monitor on this output" });
          continue;
        }
        var mons = new PHYSICAL_MONITOR[count];
        if (!GetPhysicalMonitorsFromHMONITOR(h, count, mons)) {
          results.Add(new Item { Id = mi.szDevice, Device = mi.szDevice, Error = "could not open the monitor" });
          continue;
        }

        try {
          for (int i = 0; i < mons.Length; i++) {
            var m = mons[i];
            var item = new Item {
              // Several physical monitors can hang off one adapter output, so the
              // index disambiguates. In practice this is almost always :0.
              Id = mi.szDevice + ":" + i,
              Device = mi.szDevice,
              Description = m.szDescription,
              HardwareId = HardwareIdFor(mi.szDevice),
              Primary = (mi.dwFlags & 1) != 0,
            };

            uint bright, brightMax;
            if (TryReadVcp(m.hPhysicalMonitor, VCP_BRIGHTNESS, out bright, out brightMax) && brightMax > 0) {
              item.HasBrightness = true;
              item.Brightness = bright;
              item.BrightnessMax = brightMax;
            }

            uint cur;
            if (TryReadInput(m.hPhysicalMonitor, out cur)) {
              item.HasInput = true;
              item.CurrentInput = cur;
            } else {
              item.Error = "no answer over DDC/CI - the monitor may be asleep, showing another input, or have DDC/CI switched off in its menu";
            }

            if (withCapabilities) {
              uint len;
              if (GetCapabilitiesStringLength(m.hPhysicalMonitor, out len) && len > 0 && len < 65536) {
                var sb = new StringBuilder((int)len);
                if (CapabilitiesRequestAndCapabilitiesReply(m.hPhysicalMonitor, sb, len)) {
                  item.Capabilities = sb.ToString();
                }
              }
            }

            results.Add(item);
          }
        } finally {
          DestroyPhysicalMonitors(count, mons);
        }
      }
      return results;
    }

    /** Returns the input actually reported after the write, or -1 on failure. */
    public static int SetInput(string id, uint value) {
      foreach (var h in Handles()) {
        var mi = new MONITORINFOEX();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (!GetMonitorInfo(h, ref mi)) continue;

        uint count;
        if (!GetNumberOfPhysicalMonitorsFromHMONITOR(h, out count) || count == 0) continue;
        var mons = new PHYSICAL_MONITOR[count];
        if (!GetPhysicalMonitorsFromHMONITOR(h, count, mons)) continue;

        try {
          for (int i = 0; i < mons.Length; i++) {
            if (mi.szDevice + ":" + i != id) continue;
            bool written = false;
            for (int attempt = 0; attempt < 3 && !written; attempt++) {
              written = SetVCPFeature(mons[i].hPhysicalMonitor, VCP_INPUT_SOURCE, value);
              if (!written) System.Threading.Thread.Sleep(80);
            }
            if (!written) return -1;

            // Monitors need a moment before the new value reads back, and some
            // never confirm at all once they have switched away from this input.
            System.Threading.Thread.Sleep(250);
            uint cur;
            if (TryReadInput(mons[i].hPhysicalMonitor, out cur)) return (int)cur;
            // The write succeeded; the monitor simply stopped answering, which is
            // the expected outcome when it has moved to another device.
            return (int)value;
          }
        } finally {
          DestroyPhysicalMonitors(count, mons);
        }
      }
      return -1;
    }
  }

  /**
   * Opening a link and setting the clipboard.
   *
   * ShellExecute is the only way to hand a URL to the user's default browser,
   * and it is genuinely capable of launching anything — so the scheme is checked
   * here as well as in the agent's zod schema. Two independent checks on the one
   * call in this project that can start a process is proportionate.
   */
  public static class Shell {
    public static bool OpenUrl(string url) {
      if (string.IsNullOrEmpty(url)) return false;
      // Belt and braces: the agent already rejects anything that is not http(s),
      // but this is the last line before ShellExecute and cheap to repeat.
      var lower = url.ToLowerInvariant();
      if (!lower.StartsWith("http://") && !lower.StartsWith("https://")) return false;
      if (url.IndexOf('\0') >= 0) return false;
      try {
        var psi = new System.Diagnostics.ProcessStartInfo(url);
        psi.UseShellExecute = true;
        System.Diagnostics.Process.Start(psi);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * The older shape of the same idea. Note the missing ResetDeviceFormat: the
   * vtable is one slot shorter, so this cannot share a declaration with
   * IPolicyConfig — getting that wrong calls the neighbouring method.
   */
  [Guid("568b9108-44bf-40b4-9006-86afe5b5a620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfigVista {
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr format);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, bool def, out IntPtr format);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpoint, IntPtr mix);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, bool def, out long defPeriod, out long minPeriod);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, ref long period);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr mode);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, bool visible);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator { }

  public class Session {
    public uint Pid;
    public string ProcessName;
    public string FriendlyName;
    public float Volume;
    public bool Muted;
    public int State;
    public bool IsSystem;
  }

  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out uint count);
    int Item(uint index, out IMMDevice device);
  }

  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid fmtid; public int pid; }

  /**
   * Only the layout needed to read a string property. A full PROPVARIANT is a
   * large union; this reads the first pointer-sized field, which for VT_LPWSTR
   * is the string pointer.
   */
  [StructLayout(LayoutKind.Sequential)]
  struct PROPVARIANT {
    public short vt;
    public short r1, r2, r3;
    public IntPtr p;
    public IntPtr p2;
  }

  /**
   * Undocumented but long-stable interface behind "set as default device" in the
   * sound control panel. There is no supported API for this — Microsoft never
   * exposed one — so the method order below matters: only SetDefaultEndpoint is
   * called, but every preceding slot has to be declared to line the vtable up.
   */
  [Guid("f8679f50-850a-4b0d-8bf1-4c1a4f0a8b0e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr format);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, bool def, out IntPtr format);
    [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpoint, IntPtr mix);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, bool def, out long defPeriod, out long minPeriod);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, ref long period);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr mode);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, bool visible);
  }

  /**
   * Audio output devices: listing them, and choosing which one Windows uses.
   *
   * Worth knowing what is NOT here: playing to several devices at once. Windows
   * has no API for it — a render stream goes to exactly one endpoint, and the
   * "multiple outputs" people set up elsewhere always involves a virtual audio
   * driver that presents itself as one device and fans out internally. Nothing
   * in the platform can be asked to do it.
   */
  public static class Devices {
    const int eRender = 0, eConsole = 0, eMultimedia = 1, eCommunications = 2;
    const int DEVICE_STATE_ACTIVE = 1;
    const int STGM_READ = 0;

    static PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY {
      fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14
    };
    static PROPERTYKEY PKEY_DeviceInterface_FriendlyName = new PROPERTYKEY {
      fmtid = new Guid("026e516e-b814-414b-83cd-856d6fef4822"), pid = 2
    };

    public class Item {
      public string Id;
      public string Name;
      public string Adapter;
      public bool IsDefault;
    }

    static string ReadString(IPropertyStore store, PROPERTYKEY key) {
      PROPVARIANT v;
      if (store.GetValue(ref key, out v) != 0) return "";
      if (v.p == IntPtr.Zero) return "";
      try { return Marshal.PtrToStringUni(v.p) ?? ""; } catch { return ""; }
    }

    public static List<Item> List() {
      var result = new List<Item>();
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());

      string defaultId = "";
      IMMDevice def;
      if (en.GetDefaultAudioEndpoint(eRender, eConsole, out def) == 0) {
        def.GetId(out defaultId);
      }

      IntPtr collectionPtr;
      if (en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out collectionPtr) != 0) return result;
      if (collectionPtr == IntPtr.Zero) return result;
      var collection = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(collectionPtr);

      uint count;
      collection.GetCount(out count);
      for (uint i = 0; i < count; i++) {
        IMMDevice dev;
        if (collection.Item(i, out dev) != 0) continue;

        string id;
        dev.GetId(out id);

        IntPtr storePtr;
        string name = "", adapter = "";
        if (dev.OpenPropertyStore(STGM_READ, out storePtr) == 0 && storePtr != IntPtr.Zero) {
          var store = (IPropertyStore)Marshal.GetObjectForIUnknown(storePtr);
          // The endpoint name is the useful half ("Speakers", "LG HDR 4K"); the
          // adapter name disambiguates two endpoints with the same label.
          name = ReadString(store, PKEY_Device_FriendlyName);
          adapter = ReadString(store, PKEY_DeviceInterface_FriendlyName);
          Marshal.Release(storePtr);
        }

        result.Add(new Item {
          Id = id,
          Name = string.IsNullOrEmpty(name) ? "Unknown device" : name,
          Adapter = adapter,
          IsDefault = (id == defaultId),
        });
      }
      return result;
    }

    /**
     * Switches the default output.
     *
     * All three roles are set together. Windows keeps separate defaults for
     * console, multimedia and communications, and moving only one leaves some
     * applications on the old device — which looks exactly like the switch not
     * working.
     */
    public static string SetDefault(string id) {
      if (string.IsNullOrEmpty(id)) return "empty device id";

      /**
       * There is no supported API for this. Windows never exposed one, so the
       * sound control panel's "set as default" goes through an undocumented
       * interface — and which one answers depends on the build. On this Windows
       * 11 machine the newer IID returns E_NOINTERFACE and the Vista-era one
       * works, so both are tried, each against its own coclass and its own
       * vtable shape.
       */
      var errors = new List<string>();

      // Newer interface first.
      try {
        object raw = Activator.CreateInstance(
          Type.GetTypeFromCLSID(new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")));
        var cfg = (IPolicyConfig)raw;
        int hr = cfg.SetDefaultEndpoint(id, eConsole);
        if (hr == 0) {
          // All three roles: Windows keeps separate defaults for console,
          // multimedia and communications, and moving only one leaves some
          // applications on the old device.
          cfg.SetDefaultEndpoint(id, eMultimedia);
          cfg.SetDefaultEndpoint(id, eCommunications);
          return "";
        }
        errors.Add("IPolicyConfig hr=0x" + hr.ToString("X8"));
      } catch (Exception ex) {
        errors.Add("IPolicyConfig " + ex.GetType().Name);
      }

      foreach (string clsid in new string[] {
        "294935CE-F637-4E7C-A41B-AB255460B862",
        "870af99c-171d-4f9e-af0d-e63df40c2bc9",
      }) {
        try {
          object raw = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid)));
          var cfg = (IPolicyConfigVista)raw;
          int hr = cfg.SetDefaultEndpoint(id, eConsole);
          if (hr == 0) {
            cfg.SetDefaultEndpoint(id, eMultimedia);
            cfg.SetDefaultEndpoint(id, eCommunications);
            return "";
          }
          errors.Add("Vista hr=0x" + hr.ToString("X8"));
        } catch (Exception ex) {
          errors.Add("Vista " + ex.GetType().Name);
        }
      }

      return string.Join("; ", errors.ToArray());
    }
  }

  public static class Audio {
    static Guid ctx = Guid.Empty;
    const int eRender = 0, eConsole = 0, CLSCTX_ALL = 23;
    static Guid IID_EndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static Guid IID_SessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    // Process name lookups dominate enumeration cost and the mapping never
    // changes for a live pid, so remember it. Cleared whenever a pid vanishes.
    static Dictionary<uint, string[]> nameCache = new Dictionary<uint, string[]>();

    static IMMDevice GetDefaultDevice() {
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev;
      int hr = en.GetDefaultAudioEndpoint(eRender, eConsole, out dev);
      if (hr != 0) throw new Exception("no default playback device (0x" + hr.ToString("X8") + ")");
      return dev;
    }

    static IAudioEndpointVolume GetEndpointVolume() {
      object o;
      GetDefaultDevice().Activate(IID_EndpointVolume, CLSCTX_ALL, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }

    static IAudioSessionEnumerator GetSessionEnum() {
      object o;
      GetDefaultDevice().Activate(IID_SessionManager2, CLSCTX_ALL, IntPtr.Zero, out o);
      IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
      IAudioSessionEnumerator en;
      mgr.GetSessionEnumerator(out en);
      return en;
    }

    public static float GetMaster() { float v; GetEndpointVolume().GetMasterVolumeLevelScalar(out v); return v; }
    public static void SetMaster(float v) { GetEndpointVolume().SetMasterVolumeLevelScalar(v, ref ctx); }
    public static bool GetMasterMute() { bool m; GetEndpointVolume().GetMute(out m); return m; }
    public static void SetMasterMute(bool m) { GetEndpointVolume().SetMute(m, ref ctx); }

    /**
     * The microphone is the same endpoint interface on the other data flow.
     * eCapture is 1; everything else about it is identical to the speakers,
     * which is why this is a handful of lines rather than a subsystem.
     *
     * Wrapped in its own try/catch by the caller: a machine with no microphone
     * at all is entirely normal and must not take the volume card down with it.
     */
    const int eCapture = 1;

    static IAudioEndpointVolume GetCaptureVolume() {
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev;
      int hr = en.GetDefaultAudioEndpoint(eCapture, eConsole, out dev);
      if (hr != 0) throw new Exception("no default recording device");
      object o;
      dev.Activate(IID_EndpointVolume, CLSCTX_ALL, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }

    /**
     * Deliberately no friendly name. Reading it means IPropertyStore plus
     * PROPVARIANT marshalling for what would be a label above a mute button —
     * the UI says "Microphone" and that is enough.
     */
    public static float GetMicVolume() { float v; GetCaptureVolume().GetMasterVolumeLevelScalar(out v); return v; }
    public static void SetMicVolume(float v) { GetCaptureVolume().SetMasterVolumeLevelScalar(v, ref ctx); }
    public static bool GetMicMute() { bool m; GetCaptureVolume().GetMute(out m); return m; }

    /**
     * Live input level, 0-1.
     *
     * The peak meter is a separate interface on the same endpoint and is what
     * the Windows sound panel's bouncing bar reads. It is genuinely
     * instantaneous, so it has to be sampled far more often than the 1 Hz state
     * poll to look like a meter rather than a random number.
     */
    static Guid IID_MeterInformation = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");

    public static float GetMicPeak() {
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev;
      if (en.GetDefaultAudioEndpoint(eCapture, eConsole, out dev) != 0) return -1f;
      object o;
      dev.Activate(IID_MeterInformation, CLSCTX_ALL, IntPtr.Zero, out o);
      float peak;
      ((IAudioMeterInformation)o).GetPeakValue(out peak);
      return peak;
    }
    public static void SetMicMute(bool m) { GetCaptureVolume().SetMute(m, ref ctx); }

    static string[] NamesFor(uint pid) {
      // Only pid 0 is the shared system-sounds session. A real process can also
      // be flagged as system sounds (anything using PlaySound, including .NET's
      // SoundPlayer) and for those the process name is still the useful label.
      if (pid == 0) return new string[] { "System Sounds", "System Sounds" };
      string[] cached;
      if (nameCache.TryGetValue(pid, out cached)) return cached;
      string proc = "unknown", friendly = "unknown";
      try {
        Process p = Process.GetProcessById((int)pid);
        proc = p.ProcessName;
        friendly = null;
        try {
          // What the Windows volume mixer shows: "Google Chrome", not "chrome".
          // MainModule throws for protected or cross-bitness processes.
          if (p.MainModule != null && p.MainModule.FileVersionInfo != null)
            friendly = p.MainModule.FileVersionInfo.FileDescription;
        } catch { }
        if (string.IsNullOrEmpty(friendly)) friendly = proc;
      } catch {
        return new string[] { "unknown", "unknown" };
      }
      string[] names = new string[] { proc, friendly };
      nameCache[pid] = names;
      return names;
    }

    public static List<Session> GetSessions() {
      var result = new List<Session>();
      var live = new HashSet<uint>();
      IAudioSessionEnumerator en = GetSessionEnum();
      int count; en.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl ctl;
        if (en.GetSession(i, out ctl) != 0) continue;
        IAudioSessionControl2 c2 = ctl as IAudioSessionControl2;
        if (c2 == null) continue;
        var s = new Session();
        uint pid; c2.GetProcessId(out pid); s.Pid = pid;
        int st; c2.GetState(out st); s.State = st;
        s.IsSystem = (c2.IsSystemSoundsSession() == 0);
        string[] names = NamesFor(pid);
        s.ProcessName = names[0];
        s.FriendlyName = names[1];
        live.Add(pid);
        ISimpleAudioVolume vol = ctl as ISimpleAudioVolume;
        if (vol != null) {
          float v; vol.GetMasterVolume(out v); s.Volume = v;
          bool m; vol.GetMute(out m); s.Muted = m;
        }
        result.Add(s);
      }
      // Drop cache entries for pids that no longer hold a session, so a recycled
      // pid cannot be reported under the dead process's name.
      var stale = new List<uint>();
      foreach (uint key in nameCache.Keys) if (!live.Contains(key)) stale.Add(key);
      foreach (uint key in stale) nameCache.Remove(key);
      return result;
    }

    /**
     * Applies to every session owned by the pid. An app commonly holds more than
     * one (Chrome keeps one per renderer), and changing only the first would move
     * the slider without changing what you hear.
     */
    public static int SetSessionVolume(uint pid, string expectProcess, float level,
                                       bool applyVolume, bool mute, bool applyMute) {
      IAudioSessionEnumerator en = GetSessionEnum();
      int count; en.GetCount(out count);
      int applied = 0;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl ctl;
        if (en.GetSession(i, out ctl) != 0) continue;
        IAudioSessionControl2 c2 = ctl as IAudioSessionControl2;
        if (c2 == null) continue;
        uint p; c2.GetProcessId(out p);
        if (p != pid) continue;
        // Guard against a pid recycled between the client rendering the slider
        // and the write arriving.
        if (!string.IsNullOrEmpty(expectProcess)) {
          string[] names = NamesFor(p);
          if (!string.Equals(names[0], expectProcess, StringComparison.OrdinalIgnoreCase)) continue;
        }
        ISimpleAudioVolume vol = ctl as ISimpleAudioVolume;
        if (vol == null) continue;
        if (applyVolume) vol.SetMasterVolume(level, ref ctx);
        if (applyMute) vol.SetMute(mute, ref ctx);
        applied++;
      }
      return applied;
    }
  }
}
'@

# ---------------------------------------------------------------------------
# SMTC (milestone B): real session metadata and precise transport control.
#
# GlobalSystemMediaTransportControlsSessionManager is the same API the brief
# specified for a C# helper; reaching it from PowerShell avoids requiring the
# .NET SDK to be installed just to build a console app.
#
# Measured on this machine: RequestAsync 35ms once at startup, then 1.8ms for
# playback+timeline and 6.8ms including media properties. Cheap enough for the
# 1 Hz poll.
#
# All of it is optional. If the WinRT projection is unavailable the agent falls
# back to blind media keys (milestone A), which is why every failure below sets a
# flag rather than throwing.
# ---------------------------------------------------------------------------

$script:SmtcReady = $false
$script:SmtcManager = $null
$script:AsTaskGeneric = $null

function Await-Winrt($op, $type) {
  $asTask = $script:AsTaskGeneric.MakeGenericMethod($type)
  $t = $asTask.Invoke($null, @($op))
  # Bounded: a wedged media app must not hang the host, which also serves volume.
  if (-not $t.Wait(3000)) { throw "WinRT call timed out" }
  return $t.Result
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $genericName = 'IAsyncOperation' + [char]96 + '1'
  $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                   $_.GetParameters()[0].ParameterType.Name -eq $genericName })[0]
  if ($null -eq $script:AsTaskGeneric) { throw "AsTask projection unavailable" }

  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

  $script:SmtcManager = Await-Winrt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $script:SmtcReady = ($null -ne $script:SmtcManager)
} catch {
  $script:SmtcReady = $false
}

function Get-SmtcSession {
  if (-not $script:SmtcReady) { return $null }
  try { return $script:SmtcManager.GetCurrentSession() } catch { return $null }
}

# PlaybackStatus: Closed=0 Opened=1 Changing=2 Stopped=3 Paused=4 Playing=5
function ConvertTo-StatusName($v) {
  switch ([int]$v) {
    5 { 'playing' }
    4 { 'paused' }
    3 { 'stopped' }
    default { 'unknown' }
  }
}

function Read-MediaState {
  if (-not $script:SmtcReady) { return @{ available = $false } }
  $s = Get-SmtcSession
  if ($null -eq $s) { return @{ available = $true; hasSession = $false } }

  $out = @{ available = $true; hasSession = $true }
  try { $out.app = [string]$s.SourceAppUserModelId } catch { $out.app = '' }

  try {
    $pb = $s.GetPlaybackInfo()
    $out.status = ConvertTo-StatusName $pb.PlaybackStatus
    $c = $pb.Controls
    $out.canPlay = [bool]$c.IsPlayEnabled
    $out.canPause = [bool]$c.IsPauseEnabled
    $out.canNext = [bool]$c.IsNextEnabled
    $out.canPrevious = [bool]$c.IsPreviousEnabled
    $out.canSeek = [bool]$c.IsPlaybackPositionEnabled
  } catch {
    $out.status = 'unknown'
  }

  try {
    $tl = $s.GetTimelineProperties()
    $out.positionSec = [math]::Round($tl.Position.TotalSeconds, 1)
    $out.durationSec = [math]::Round($tl.EndTime.TotalSeconds, 1)
  } catch { }

  try {
    $props = Await-Winrt ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $out.title = [string]$props.Title
    $out.artist = [string]$props.Artist
    $out.album = [string]$props.AlbumTitle
    $out.hasThumbnail = ($null -ne $props.Thumbnail)
  } catch { }

  return $out
}

function Get-ThumbnailBase64 {
  $s = Get-SmtcSession
  if ($null -eq $s) { return $null }
  try {
    $props = Await-Winrt ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($null -eq $props.Thumbnail) { return $null }
    $raw = Await-Winrt ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $raw) { return $null }

    # PowerShell 5.1 hands back an unprojected System.__ComObject here and will
    # not cast it to the WinRT interface, so GetInputStreamAt and DataReader are
    # both unreachable -- which is why artwork silently never loaded. Invoking
    # the AsStreamForRead extension through reflection lets the CLR do the
    # QueryInterface and yields an ordinary .NET Stream.
    if ($null -eq $script:AsStreamForRead) {
      $script:AsStreamForRead = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 })[0]
    }
    if ($null -eq $script:AsStreamForRead) { return $null }

    $stream = $script:AsStreamForRead.Invoke($null, @($raw))
    $ms = New-Object System.IO.MemoryStream
    $stream.CopyTo($ms)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $stream.Dispose()

    # Album art is tens of kilobytes; anything far larger is not worth pushing to
    # a phone over Wi-Fi and would sit in the agent's memory until the track ends.
    if ($bytes.Length -le 0 -or $bytes.Length -gt 4000000) { return $null }

    # Sniff the format from the magic bytes: the stream's ContentType property is
    # not reachable for the same projection reason as above.
    $type = 'image/jpeg'
    if ($bytes.Length -ge 4 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $type = 'image/png' }
    elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { $type = 'image/jpeg' }
    elseif ($bytes.Length -ge 12 -and $bytes[0] -eq 0x52 -and $bytes[8] -eq 0x57) { $type = 'image/webp' }

    return @{ base64 = [Convert]::ToBase64String($bytes); contentType = $type }
  } catch {
    return $null
  }
}

function Invoke-MediaAction($action) {
  $s = Get-SmtcSession
  if ($null -eq $s) { return $false }
  try {
    switch ($action) {
      'play'      { return [bool](Await-Winrt ($s.TryPlayAsync()) ([bool])) }
      'pause'     { return [bool](Await-Winrt ($s.TryPauseAsync()) ([bool])) }
      'playPause' { return [bool](Await-Winrt ($s.TryTogglePlayPauseAsync()) ([bool])) }
      'toggle'    { return [bool](Await-Winrt ($s.TryTogglePlayPauseAsync()) ([bool])) }
      'next'      { return [bool](Await-Winrt ($s.TrySkipNextAsync()) ([bool])) }
      'previous'  { return [bool](Await-Winrt ($s.TrySkipPreviousAsync()) ([bool])) }
      'stop'      { return [bool](Await-Winrt ($s.TryStopAsync()) ([bool])) }
      default     { return $false }
    }
  } catch {
    return $false
  }
}

function Invoke-MediaSeek($positionSec) {
  $s = Get-SmtcSession
  if ($null -eq $s) { return $false }
  try {
    # TryChangePlaybackPositionAsync takes 100-nanosecond ticks, not seconds.
    $ticks = [long]([double]$positionSec * 10000000)
    return [bool](Await-Winrt ($s.TryChangePlaybackPositionAsync($ticks)) ([bool]))
  } catch {
    return $false
  }
}

# Friendly monitor names from EDID, keyed by plug-and-play id.
#
# The description Windows returns from the monitor-configuration API is often
# just "Generic PnP Monitor"; EDID has the real model, e.g. "EK221Q E3".
# Cached, because WMI is not cheap and monitor names never change at runtime.
$script:MonitorNameCache = $null
$script:AsStreamForRead = $null

function Get-MonitorNames {
  if ($null -ne $script:MonitorNameCache) { return $script:MonitorNameCache }
  $map = @{}
  try {
    foreach ($m in Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction Stop) {
      $name = ($m.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join ''
      if ([string]::IsNullOrWhiteSpace($name)) { continue }
      # InstanceName looks like DISPLAY\ACME1234\5&1a2b3c4d&0&UID256_0
      $parts = $m.InstanceName -split '\\'
      if ($parts.Count -ge 3) {
        $key = $parts[1] + '\' + ($parts[2] -replace '_\d+$', '')
        $map[$key] = $name
      }
    }
  } catch { }
  $script:MonitorNameCache = $map
  return $map
}

function Read-State {
  $sessions = @()
  foreach ($s in [PcrAudio.Audio]::GetSessions()) {
    $sessions += @{
      pid     = [int]$s.Pid
      process = $s.ProcessName
      name    = $s.FriendlyName
      volume  = [math]::Round($s.Volume * 100, 0)
      muted   = [bool]$s.Muted
      state   = [int]$s.State
      system  = [bool]$s.IsSystem
    }
  }
  return @{
    master   = [math]::Round([PcrAudio.Audio]::GetMaster() * 100, 0)
    muted    = [bool][PcrAudio.Audio]::GetMasterMute()
    sessions = @($sessions)
  }
}

function Write-Line($obj) {
  # Depth matters: the default of 2 would flatten the session list into type names.
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

# Prove the C# compiled and COM is reachable before the agent trusts this process.
try {
  $null = [PcrAudio.Audio]::GetMaster()
  # smtc tells the agent whether milestone B is available or it should fall back
  # to blind media keys.
  Write-Line @{ ready = $true; smtc = $script:SmtcReady }
} catch {
  Write-Line @{ ready = $false; error = $_.Exception.Message }
  exit 1
}

# Read asynchronously rather than with a blocking ReadLine.
#
# A blocking read leaves this process alive forever if the agent is killed
# outright (Task Manager, a crash, a hard kill from a test harness) instead of
# shutting down cleanly: Windows does not terminate children with their parent,
# and the EOF that a closed stdin should deliver does not always arrive. Waking
# up every second to confirm the parent still exists guarantees this exits.
$reader = [Console]::In
$pending = $null

while ($true) {
  if ($null -eq $pending) { $pending = $reader.ReadLineAsync() }

  if (-not $pending.Wait(1000)) {
    if ($ParentPid -gt 0) {
      $alive = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
      if ($null -eq $alive) { break }   # the agent is gone; do not linger

      # Windows recycles pids, and this host can outlive several agents during a
      # test run. A pid that exists is not proof it is *our* agent, so compare
      # start times too -- otherwise a reused pid makes this process immortal.
      if ($ParentStartedMs -gt 0) {
        try {
          $epoch = [datetime]'1970-01-01T00:00:00Z'
          $startedMs = ($alive.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds
          # Several seconds of slack: the agent records its own start time from
          # process.uptime(), which is close but not identical to the OS value.
          if ([math]::Abs($startedMs - $ParentStartedMs) -gt 10000) { break }
        } catch {
          # StartTime can be denied for a process we no longer own; treat that
          # as the parent being gone rather than lingering forever.
          break
        }
      }
    }
    continue
  }

  $line = $pending.Result
  $pending = $null
  if ($null -eq $line) { break }   # stdin closed: the agent is shutting down
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $reqId = $null
  try {
    $req = $line | ConvertFrom-Json
    $reqId = $req.id
    switch ($req.cmd) {
      'state' {
        Write-Line @{ id = $reqId; ok = $true; data = (Read-State) }
      }
      'setMaster' {
        [PcrAudio.Audio]::SetMaster([float]$req.volume)
        Write-Line @{ id = $reqId; ok = $true; data = (Read-State) }
      }
      'setMasterMute' {
        [PcrAudio.Audio]::SetMasterMute([bool]$req.muted)
        Write-Line @{ id = $reqId; ok = $true; data = (Read-State) }
      }
      'setApp' {
        $n = [PcrAudio.Audio]::SetSessionVolume([uint32]$req.pid, [string]$req.process,
                                                [float]$req.volume, $true, $false, $false)
        Write-Line @{ id = $reqId; ok = $true; applied = $n; data = (Read-State) }
      }
      'setAppMute' {
        $n = [PcrAudio.Audio]::SetSessionVolume([uint32]$req.pid, [string]$req.process,
                                                0, $false, [bool]$req.muted, $true)
        Write-Line @{ id = $reqId; ok = $true; applied = $n; data = (Read-State) }
      }
      'micState' {
        try {
          Write-Line @{ id = $reqId; ok = $true; data = @{
            available = $true
            muted = [bool][PcrAudio.Audio]::GetMicMute()
            volume = [math]::Round([PcrAudio.Audio]::GetMicVolume() * 100)
          } }
        } catch {
          # No recording device is perfectly normal; report it rather than fail.
          Write-Line @{ id = $reqId; ok = $true; data = @{ available = $false } }
        }
      }
      'setMicMute' {
        [PcrAudio.Audio]::SetMicMute([bool]$req.muted)
        Write-Line @{ id = $reqId; ok = $true }
      }
      'setMicVolume' {
        [PcrAudio.Audio]::SetMicVolume([float]$req.volume)
        Write-Line @{ id = $reqId; ok = $true }
      }
      'setBrightness' {
        $applied = [PcrAudio.Monitors]::SetBrightness([string]$req.monitor, [uint32]$req.percent)
        if ($applied -lt 0) {
          Write-Line @{ id = $reqId; ok = $false; error = 'the monitor refused the brightness change' }
        } else {
          Write-Line @{ id = $reqId; ok = $true; data = @{ brightness = $applied } }
        }
      }
      'audioDevices' {
        $items = [PcrAudio.Devices]::List()
        $out = @()
        foreach ($d in $items) {
          $out += @{ id = $d.Id; name = $d.Name; adapter = $d.Adapter; isDefault = $d.IsDefault }
        }
        Write-Line @{ id = $reqId; ok = $true; data = @{ devices = $out } }
      }
      'setAudioDevice' {
        $err = [PcrAudio.Devices]::SetDefault([string]$req.device)
        if ([string]::IsNullOrEmpty($err)) { Write-Line @{ id = $reqId; ok = $true } }
        else { Write-Line @{ id = $reqId; ok = $false; error = ('Windows refused the device change: ' + $err) } }
      }
      'micPeak' {
        try {
          Write-Line @{ id = $reqId; ok = $true; data = @{ peak = [PcrAudio.Audio]::GetMicPeak() } }
        } catch {
          Write-Line @{ id = $reqId; ok = $true; data = @{ peak = -1 } }
        }
      }
      'getClipboard' {
        try {
          # -Raw keeps newlines; without it multi-line text arrives as an array.
          $text = Get-Clipboard -Raw -ErrorAction Stop
          if ($null -eq $text) { $text = '' }
          Write-Line @{ id = $reqId; ok = $true; data = @{ text = [string]$text } }
        } catch {
          # A clipboard holding an image or a file list is not text; that is not
          # an error, there is simply nothing to mirror.
          Write-Line @{ id = $reqId; ok = $true; data = @{ text = '' } }
        }
      }
      'setClipboard' {
        Set-Clipboard -Value ([string]$req.text)
        Write-Line @{ id = $reqId; ok = $true }
      }
      'openUrl' {
        $opened = [PcrAudio.Shell]::OpenUrl([string]$req.url)
        if ($opened) { Write-Line @{ id = $reqId; ok = $true } }
        else { Write-Line @{ id = $reqId; ok = $false; error = 'could not open that link' } }
      }
      'monitors' {
        $withCaps = [bool]$req.withCapabilities
        $items = [PcrAudio.Monitors]::Enumerate($withCaps)
        $out = @()
        foreach ($m in $items) {
          $out += @{
            id = $m.Id; device = $m.Device; description = $m.Description
            hardwareId = $m.HardwareId; primary = $m.Primary
            hasInput = $m.HasInput; currentInput = [int]$m.CurrentInput
            hasBrightness = $m.HasBrightness; brightness = [int]$m.Brightness
            brightnessMax = [int]$m.BrightnessMax
            capabilities = $m.Capabilities; error = $m.Error
          }
        }
        Write-Line @{ id = $reqId; ok = $true; data = @{ monitors = $out; names = (Get-MonitorNames) } }
      }
      'monitorSetInput' {
        $applied = [PcrAudio.Monitors]::SetInput([string]$req.monitor, [uint32]$req.input)
        if ($applied -lt 0) {
          Write-Line @{ id = $reqId; ok = $false; error = 'the monitor refused the input change' }
        } else {
          Write-Line @{ id = $reqId; ok = $true; data = @{ currentInput = $applied } }
        }
      }
      'system' {
        $done = switch ($req.action) {
          'lock'       { [PcrAudio.SystemActions]::Lock() }
          'sleep'      { [PcrAudio.SystemActions]::Sleep() }
          'displayOff' { [PcrAudio.SystemActions]::DisplayOff() }
          default      { $null }
        }
        if ($null -eq $done) {
          Write-Line @{ id = $reqId; ok = $false; error = ("unknown system action: " + $req.action) }
        } else {
          Write-Line @{ id = $reqId; ok = $true; data = @{ applied = [bool]$done } }
        }
      }
      'mediaState' {
        Write-Line @{ id = $reqId; ok = $true; data = (Read-MediaState) }
      }
      'mediaControl' {
        $applied = Invoke-MediaAction $req.action
        Write-Line @{ id = $reqId; ok = $true; data = @{ applied = $applied } }
      }
      'mediaSeek' {
        $applied = Invoke-MediaSeek $req.positionSec
        Write-Line @{ id = $reqId; ok = $true; data = @{ applied = $applied } }
      }
      'mediaThumbnail' {
        $thumb = Get-ThumbnailBase64
        if ($null -eq $thumb) {
          Write-Line @{ id = $reqId; ok = $true; data = $null }
        } else {
          Write-Line @{ id = $reqId; ok = $true; data = $thumb }
        }
      }
      'mediaKey' {
        $vk = switch ($req.key) {
          'playPause' { [PcrAudio.MediaKeys]::VK_MEDIA_PLAY_PAUSE }
          'next'      { [PcrAudio.MediaKeys]::VK_MEDIA_NEXT_TRACK }
          'previous'  { [PcrAudio.MediaKeys]::VK_MEDIA_PREV_TRACK }
          'stop'      { [PcrAudio.MediaKeys]::VK_MEDIA_STOP }
          default     { $null }
        }
        if ($null -eq $vk) {
          Write-Line @{ id = $reqId; ok = $false; error = ("unknown media key: " + $req.key) }
        } else {
          [PcrAudio.MediaKeys]::Send($vk)
          Write-Line @{ id = $reqId; ok = $true }
        }
      }
      'ping' {
        Write-Line @{ id = $reqId; ok = $true }
      }
      default {
        Write-Line @{ id = $reqId; ok = $false; error = ("unknown command: " + $req.cmd) }
      }
    }
  } catch {
    # One bad command must not kill the host; the agent would just have to
    # restart it and pay the compile cost again.
    Write-Line @{ id = $reqId; ok = $false; error = $_.Exception.Message }
  }
}
`;
