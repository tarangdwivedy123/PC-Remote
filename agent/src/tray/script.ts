/**
 * Tray icon and the first-run window.
 *
 * A separate PowerShell process rather than part of the interop host, because a
 * WinForms tray icon needs its own message pump: the host answers requests in a
 * blocking read loop, and a window that stops pumping stops repainting and gets
 * marked "not responding" by Windows.
 *
 * The C# owns everything -- pump, command reader, watchdog -- and PowerShell is
 * only the compiler and launcher. An earlier version drove the pump from
 * PowerShell with DoEvents between reads, which left the window barely pumping
 * at all: it answered the agent in under 50ms while failing to answer a WM_NULL
 * ping within three seconds.
 *
 * Commands are tab-separated lines rather than JSON so the C# needs no parser.
 */
export const TRAY_SCRIPT = String.raw`
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Add-Type -Language CSharp -ReferencedAssemblies @('System.Windows.Forms','System.Drawing') -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace PcrTray {

  /**
   * The window shown on first run, and whenever "Show QR code" is picked from
   * the tray.
   *
   * Everything on it is aimed at somebody who has never opened a terminal: one
   * QR to point a camera at, the network name they have to match, and the
   * address in plain text for the case where the camera will not scan.
   */
  public class QrForm : Form {
    readonly bool[][] modules;
    readonly string url;
    readonly string network;
    readonly string pin;

    public QrForm(bool[][] modules, string url, string network, string pin) {
      this.modules = modules;
      this.url = url;
      this.network = network;
      this.pin = pin;

      Text = "PC Remote";
      // Fixed size and no maximise: this is a card to look at, not a workspace,
      // and letting it be resized only creates ways for it to look broken.
      FormBorderStyle = FormBorderStyle.FixedDialog;
      MaximizeBox = false;
      MinimizeBox = false;
      StartPosition = FormStartPosition.CenterScreen;
      ClientSize = new Size(420, 560);
      BackColor = Color.White;
      ShowInTaskbar = true;
      DoubleBuffered = true;
    }

    /**
     * Stops being a nuisance once it has been seen: it is raised above other
     * windows to get noticed, then steps back to normal z-order as soon as the
     * user clicks something else.
     */
    protected override void OnDeactivate(EventArgs e) {
      TopMost = false;
      base.OnDeactivate(e);
    }

    protected override void OnPaint(PaintEventArgs e) {
      base.OnPaint(e);
      var g = e.Graphics;
      g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

      using (var title = new Font("Segoe UI", 15f, FontStyle.Bold))
      using (var body = new Font("Segoe UI", 10f))
      using (var mono = new Font("Consolas", 11f, FontStyle.Bold))
      using (var small = new Font("Segoe UI", 8.5f))
      using (var dark = new SolidBrush(Color.FromArgb(28, 30, 34)))
      using (var grey = new SolidBrush(Color.FromArgb(105, 112, 122))) {

        g.DrawString("Scan this with your phone", title, dark, 24, 20);
        g.DrawString("Point your phone camera at the code and tap the link.",
                     body, grey, 24, 52);

        // The QR itself. Quiet zone included: a code drawn flush to a border is
        // measurably harder for a phone camera to lock onto.
        int quiet = 2;
        int count = modules.Length + quiet * 2;
        int box = 280 / count;
        int size = box * count;
        int left = (ClientSize.Width - size) / 2;
        int top = 88;

        g.FillRectangle(Brushes.White, left - 4, top - 4, size + 8, size + 8);
        using (var black = new SolidBrush(Color.Black)) {
          for (int y = 0; y < modules.Length; y++) {
            for (int x = 0; x < modules[y].Length; x++) {
              if (!modules[y][x]) continue;
              g.FillRectangle(black, left + (x + quiet) * box, top + (y + quiet) * box, box, box);
            }
          }
        }

        int cursor = top + size + 24;

        /**
         * The single most common reason this fails for people, so it is stated
         * plainly and names the actual network rather than saying "the same
         * Wi-Fi" and leaving them to work out which.
         */
        if (!string.IsNullOrEmpty(network)) {
          using (var warnBack = new SolidBrush(Color.FromArgb(255, 248, 225)))
          using (var warnText = new SolidBrush(Color.FromArgb(120, 85, 10))) {
            g.FillRectangle(warnBack, 24, cursor, ClientSize.Width - 48, 46);
            g.DrawString("Your phone must be on the same Wi-Fi:", small, warnText, 34, cursor + 6);
            using (var bold = new Font("Segoe UI", 10f, FontStyle.Bold)) {
              g.DrawString(network, bold, warnText, 34, cursor + 22);
            }
          }
          cursor += 60;
        }

        g.DrawString("Or type this address into your phone browser:", small, grey, 24, cursor);
        g.DrawString(url, mono, dark, 24, cursor + 18);
        if (!string.IsNullOrEmpty(pin)) {
          g.DrawString("then enter PIN  " + pin, small, grey, 24, cursor + 42);
        }
      }
    }
  }

  /**
   * Tray presence, and the whole of the tray process logic.
   *
   * This owns the message pump, the command reader and the parent watchdog.
   *
   * The previous arrangement was a PowerShell loop calling DoEvents between
   * other work. It answered the agent quickly, so it looked healthy, but the
   * window itself barely pumped messages: it would not answer a WM_NULL ping
   * within three seconds. A window that does not pump does not repaint, does not
   * respond to clicks, and gets marked "not responding" by Windows -- which is
   * what made the app feel laggy and take several clicks to open.
   *
   * Application.Run gives the window a real pump. Commands arrive on a
   * background thread and are marshalled onto the UI thread, so reading input
   * can never block painting again.
   */
  public class Tray : ApplicationContext {
    readonly NotifyIcon icon;
    /** Hidden window, used only as a thread marshalling target for BeginInvoke. */
    readonly Form marshaller;
    readonly object writeLock = new object();

    bool[][] modules;
    string url = "";
    string network = "";
    string pin = "";
    QrForm window;
    IntPtr parentHandle = IntPtr.Zero;

    [DllImport("user32.dll", EntryPoint = "ShowWindow")]
    static extern bool ShowWindowNative(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    public Tray(int parentPid) {
      marshaller = new Form();
      marshaller.FormBorderStyle = FormBorderStyle.None;
      marshaller.ShowInTaskbar = false;
      marshaller.StartPosition = FormStartPosition.Manual;
      marshaller.Location = new Point(-32000, -32000);
      marshaller.Size = new Size(1, 1);
      // Force the handle into existence: BeginInvoke needs one, and this window
      // is never shown.
      IntPtr unused = marshaller.Handle;

      var menu = new ContextMenuStrip();
      menu.Items.Add("Show QR code", null, delegate { ShowWindow(); });
      menu.Items.Add("Open dashboard on this PC", null, delegate {
        try {
          var psi = new System.Diagnostics.ProcessStartInfo(url);
          psi.UseShellExecute = true;
          System.Diagnostics.Process.Start(psi);
        } catch { }
      });
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Quit PC Remote", null, delegate {
        Emit("quit");
        ExitThread();
      });

      icon = new NotifyIcon();
      icon.Icon = SystemIcons.Application;
      icon.Text = "PC Remote";
      icon.Visible = true;
      icon.ContextMenuStrip = menu;
      icon.DoubleClick += delegate { ShowWindow(); };

      /**
       * Watchdog for the agent. SYNCHRONIZE plus a zero-timeout wait costs a few
       * microseconds, unlike the Get-Process call it replaces, which measured
       * 3.6ms and ran on the same thread as the message pump.
       *
       * A backstop only: the primary signal is standard input closing, which
       * happens the moment the agent dies.
       */
      if (parentPid > 0) {
        parentHandle = OpenProcess(0x00100000 /* SYNCHRONIZE */, false, parentPid);
        if (parentHandle != IntPtr.Zero) {
          var watchdog = new System.Windows.Forms.Timer();
          watchdog.Interval = 3000;
          watchdog.Tick += delegate {
            if (WaitForSingleObject(parentHandle, 0) == 0 /* WAIT_OBJECT_0 */) ExitThread();
          };
          watchdog.Start();
        }
      }
    }

    public void SetIcon(Icon custom) {
      if (custom != null) icon.Icon = custom;
    }

    /** Writes one protocol line to the agent. Locked: called from two threads. */
    void Emit(string line) {
      lock (writeLock) {
        try {
          Console.Out.WriteLine(line);
          Console.Out.Flush();
        } catch { }
      }
    }

    public void Ready() {
      Emit("ready");
    }

    /**
     * Reads commands on a background thread.
     *
     * Deliberately not on the UI thread. Reading input there is what stalled the
     * pump before: the loop alternated between waiting for a line and briefly
     * pumping messages, so the window spent most of its life not listening to
     * Windows at all.
     */
    public void StartReader() {
      var thread = new Thread(delegate () {
        try {
          string line;
          while ((line = Console.In.ReadLine()) != null) {
            string captured = line;
            try {
              marshaller.BeginInvoke((Action)delegate { Dispatch(captured); });
            } catch {
              return;   // the UI thread is gone; nothing left to deliver to
            }
          }
        } catch { }

        // Standard input closed, which means the agent exited.
        try {
          marshaller.BeginInvoke((Action)delegate { ExitThread(); });
        } catch { }
      });
      thread.IsBackground = true;
      thread.Start();
    }

    /**
     * Tab-separated commands rather than JSON, so this side needs no parser.
     * The agent is the only thing that ever writes here, and none of the fields
     * it sends can contain a tab.
     */
    void Dispatch(string line) {
      try {
        string[] parts = line.Split('\t');
        if (parts[0] == "show") {
          ShowWindow();
        } else if (parts[0] == "update" && parts.Length >= 5) {
          Update(ParseQr(parts[4]), parts[1], parts[2], parts[3]);
        } else if (parts[0] == "balloon" && parts.Length >= 3) {
          Balloon(parts[1], parts[2]);
        } else if (parts[0] == "quit") {
          ExitThread();
        }
      } catch (Exception ex) {
        Emit("err " + ex.Message.Replace('\t', ' ').Replace('\n', ' '));
      }
    }

    /**
     * Rows of "0" and "1" separated by semicolons.
     *
     * The agent already has a QR encoder, and a second implementation here could
     * disagree with it, so the finished grid is sent rather than the text.
     */
    static bool[][] ParseQr(string encoded) {
      string[] rows = encoded.Split(';');
      var grid = new bool[rows.Length][];
      for (int y = 0; y < rows.Length; y++) {
        string row = rows[y];
        grid[y] = new bool[row.Length];
        for (int x = 0; x < row.Length; x++) grid[y][x] = row[x] == '1';
      }
      return grid;
    }

    public void Update(bool[][] m, string u, string n, string p) {
      modules = m; url = u; network = n; pin = p;
      icon.Text = "PC Remote - " + u;
    }

    public void ShowWindow() {
      if (modules == null) return;
      // Rebuilt each time: the pairing code rotates once spent, so a window kept
      // around would keep showing a QR that no longer works.
      if (window != null && !window.IsDisposed) { window.Close(); window.Dispose(); }
      window = new QrForm(modules, url, network, pin);
      window.Show();

      /**
       * Form.Show() alone is not enough here, and the reason is not obvious.
       *
       * The agent starts this process with the console hidden, which puts
       * SW_HIDE into its STARTUPINFO. Windows applies that value to the process
       * FIRST ShowWindow call in place of whatever was requested, so the first
       * window opened comes up correctly sized and positioned but invisible.
       * Calling through to the API directly spends that one substitution and
       * then shows the window for real.
       */
      ShowWindowNative(window.Handle, 5 /* SW_SHOW */);
      window.WindowState = FormWindowState.Normal;

      /**
       * TopMost is what actually raises it.
       *
       * SetForegroundWindow is unreliable by design: Windows refuses to let a
       * background process steal focus, and this is a background process. So the
       * window was opening correctly but behind whatever the user was looking
       * at, which is indistinguishable from the click having done nothing -- and
       * the natural response is to click again, launching another copy.
       */
      window.TopMost = true;
      window.BringToFront();
      SetForegroundWindow(window.Handle);
      window.Activate();
    }

    public void Balloon(string title, string text) {
      icon.BalloonTipTitle = title;
      icon.BalloonTipText = text;
      icon.ShowBalloonTip(5000);
    }

    protected override void Dispose(bool disposing) {
      if (disposing) {
        // Explicit: a NotifyIcon that is not hidden leaves a ghost in the tray
        // until the user hovers over it.
        icon.Visible = false;
        icon.Dispose();
        if (window != null && !window.IsDisposed) window.Dispose();
        marshaller.Dispose();
      }
      base.Dispose(disposing);
    }
  }
}
'@

$tray = New-Object PcrTray.Tray $ParentPid

$iconPath = Join-Path ([System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path)) 'pcr-tray.ico'
if (Test-Path $iconPath) {
  try { $tray.SetIcon((New-Object System.Drawing.Icon $iconPath)) } catch { }
}

$tray.StartReader()
$tray.Ready()

# A real message pump. The window is responsive for as long as this runs, and it
# returns only when the tray asks to exit -- the user picking Quit, the agent
# closing standard input, or the watchdog noticing the agent has gone.
[System.Windows.Forms.Application]::Run($tray)
$tray.Dispose()
`;
