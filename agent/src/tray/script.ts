/**
 * Tray icon and the first-run window.
 *
 * A separate PowerShell process rather than part of the interop host, because a
 * WinForms tray icon needs its own message pump: the host answers requests in a
 * blocking read loop, and a window that stops pumping stops repainting and gets
 * marked "not responding" by Windows.
 *
 * Same JSON-lines protocol as the interop host, so the agent talks to both the
 * same way.
 */
export const TRAY_SCRIPT = String.raw`
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Add-Type -Language CSharp -ReferencedAssemblies @('System.Windows.Forms','System.Drawing') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
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
        g.DrawString("Point your phone's camera at the code and tap the link.",
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

        g.DrawString("Or type this address into your phone's browser:", small, grey, 24, cursor);
        g.DrawString(url, mono, dark, 24, cursor + 18);
        if (!string.IsNullOrEmpty(pin)) {
          g.DrawString("then enter PIN  " + pin, small, grey, 24, cursor + 42);
        }
      }
    }
  }

  /**
   * Tray presence.
   *
   * Without this the agent is an invisible background process: no way to see
   * whether it is running, no way to get the QR back once the window is closed,
   * and no way to stop it short of Task Manager. That gap is most of the
   * difference between a script and something that can be handed to somebody.
   */
  public class Tray : ApplicationContext {
    readonly NotifyIcon icon;
    bool[][] modules;
    string url = "";
    string network = "";
    string pin = "";
    QrForm window;

    /**
     * Polled by the host script rather than raised as an event.
     *
     * PowerShell runs Register-ObjectEvent handlers in a separate runspace, which
     * cannot safely touch WinForms objects living on this STA thread — an event
     * that tried to open the window from there did nothing at all. Everything the
     * menu does is handled here, on the UI thread, and only this flag crosses
     * back.
     */
    public volatile bool QuitFlag = false;

    public Tray() {
      var menu = new ContextMenuStrip();
      menu.Items.Add("Show QR code", null, (s, e) => ShowWindow());
      menu.Items.Add("Open dashboard on this PC", null, (s, e) => {
        try {
          var psi = new System.Diagnostics.ProcessStartInfo(url);
          psi.UseShellExecute = true;
          System.Diagnostics.Process.Start(psi);
        } catch { }
      });
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Quit PC Remote", null, (s, e) => { QuitFlag = true; });

      icon = new NotifyIcon {
        Icon = SystemIcons.Application,
        Text = "PC Remote",
        Visible = true,
        ContextMenuStrip = menu,
      };
      icon.DoubleClick += (s, e) => ShowWindow();
    }

    public void SetIcon(Icon custom) {
      if (custom != null) icon.Icon = custom;
    }

    public void Update(bool[][] m, string u, string n, string p) {
      modules = m; url = u; network = n; pin = p;
      icon.Text = "PC Remote — " + u;
    }

    [DllImport("user32.dll", EntryPoint = "ShowWindow")]
    static extern bool ShowWindowNative(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

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
       * SW_HIDE into its STARTUPINFO. Windows applies that value to the
       * process's FIRST ShowWindow call in place of whatever was requested, so
       * the first window opened comes up correctly sized and positioned but
       * invisible. Calling through to the API directly spends that one
       * substitution and then shows the window for real.
       */
      ShowWindowNative(window.Handle, 5 /* SW_SHOW */);
      window.WindowState = FormWindowState.Normal;
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
      }
      base.Dispose(disposing);
    }
  }
}
'@

$tray = New-Object PcrTray.Tray

$iconPath = Join-Path ([System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path)) 'pcr-tray.ico'
if (Test-Path $iconPath) {
  try { $tray.SetIcon((New-Object System.Drawing.Icon $iconPath)) } catch { }
}

function Write-Line($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

Write-Line @{ ready = $true }

# Everything the menu does happens inside the C# on this thread. The loop only
# pumps messages, reads commands, and watches the quit flag -- no
# Register-ObjectEvent, whose handlers run in a separate runspace and silently
# fail to touch WinForms objects living here.
$reader = [Console]::In
$pending = $null
$running = $true

while ($running) {
  [System.Windows.Forms.Application]::DoEvents()

  if ($tray.QuitFlag) { break }

  # Non-blocking read. A blocking ReadLine would stop the message pump, and a
  # window that stops pumping stops repainting and gets marked "not responding".
  if ($null -eq $pending) { $pending = $reader.ReadLineAsync() }
  if ($pending.Wait(40)) {
    $line = $pending.Result
    $pending = $null
    if ($null -eq $line) { break }
    if ($line.Trim() -ne '') {
      try {
        $req = $line | ConvertFrom-Json
        switch ($req.cmd) {
          'update' {
            # The grid arrives as rows of 0/1 so the tray needs no QR encoder of
            # its own; the agent already has one, and two could disagree.
            $rows = New-Object 'bool[][]' $req.modules.Count
            for ($i = 0; $i -lt $req.modules.Count; $i++) {
              $row = $req.modules[$i]
              $arr = New-Object 'bool[]' $row.Count
              for ($j = 0; $j -lt $row.Count; $j++) { $arr[$j] = [bool]$row[$j] }
              $rows[$i] = $arr
            }
            $tray.Update($rows, [string]$req.url, [string]$req.network, [string]$req.pin)
            Write-Line @{ id = $req.id; ok = $true }
          }
          'show'    { $tray.ShowWindow(); Write-Line @{ id = $req.id; ok = $true } }
          'balloon' { $tray.Balloon([string]$req.title, [string]$req.text); Write-Line @{ id = $req.id; ok = $true } }
          'quit'    { $running = $false }
          default   { Write-Line @{ id = $req.id; ok = $false; error = 'unknown command' } }
        }
      } catch {
        Write-Line @{ ok = $false; error = $_.Exception.Message }
      }
    }
  }

  # Same liveness guard the interop host uses: if the agent dies, its tray icon
  # must not outlive it and offer to control a PC that nothing is listening to.
  if ($ParentPid -gt 0) {
    if ($null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  }
}

Write-Line @{ quit = $true }
$tray.Dispose()
[System.Windows.Forms.Application]::DoEvents()
`;
