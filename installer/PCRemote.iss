; Installer for PC Remote.
;
; Its job is to remove every step between downloading a file and the phone
; working: put the app somewhere sensible, let it through the firewall on
; private networks only, start it with Windows, and leave a clean way to
; uninstall it.
;
; Built by scripts/dist.mjs, which passes the version in as /DAppVersion.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName "PC Remote"
#define AppExe "PCRemote.exe"
#define AppPublisher "PC Remote"

[Setup]
AppId={{8F3A9C41-6B2D-4E77-9A15-3C8E5D0B7A62}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\PC Remote
DefaultGroupName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
OutputDir=..\release
; Deliberately unversioned. GitHub's /releases/latest/download/<name> route needs
; an exact filename, so a version in it would break the download button on the
; site every single release. The version is in the exe's properties and on the
; releases page.
OutputBaseFilename=PCRemote-Setup
SetupIconFile=pcremote.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Admin is needed once, to add the firewall rule. Doing it here means the user
; never meets the Windows firewall prompt, whose default button is Cancel and
; which silently breaks the app for anyone who picks it.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
DisableProgramGroupPage=yes
DisableReadyPage=no
LicenseFile=
; Nothing here is worth a reboot.
RestartIfNeededByRun=no
CloseApplications=yes
CloseApplicationsFilter=*.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startup"; Description: "Start {#AppName} when I sign in"; GroupDescription: "Startup"
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"; Flags: unchecked

[Files]
Source: "..\release\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "pcremote.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\pcremote.ico"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\pcremote.ico"; Tasks: desktopicon

[Run]
; Autostart is per-user, not machine-wide: the app pairs with one person's phone
; and keeps its config under their profile, and two accounts starting it at once
; would fight over the same port.
;
; The --startup flag marks this as a launch at login, which starts quietly. A
; launch the user performed themselves always shows the QR window instead: an
; app that answers a double-click with nothing on screen looks broken, whatever
; it is busy doing in the background.
;
; Written through reg.exe with runasoriginaluser rather than an [Registry] entry
; because this installer runs elevated for the firewall rule. In that state HKCU
; is the *elevating* account, so an admin installing for somebody else would
; silently set up autostart on the wrong profile.
Filename: "{sys}\reg.exe"; \
  Parameters: "add ""HKCU\Software\Microsoft\Windows\CurrentVersion\Run"" /v PCRemote /t REG_SZ /d ""\""{app}\{#AppExe}\"" --startup"" /f"; \
  Flags: runhidden runasoriginaluser waituntilterminated; Tasks: startup

; Private and domain profiles only. This app is LAN-only by design and must
; never be reachable from a public network -- a coffee-shop Wi-Fi is exactly the
; case the Public profile exists for.
Filename: "netsh"; \
  Parameters: "advfirewall firewall add rule name=""PC Remote"" dir=in action=allow program=""{app}\{#AppExe}"" enable=yes profile=private,domain protocol=tcp localport=8765"; \
  Flags: runhidden waituntilterminated; StatusMsg: "Allowing PC Remote through the firewall..."

Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""PC Remote"""; \
  Flags: runhidden; RunOnceId: "RemoveFirewallRule"

; No runasoriginaluser here — [UninstallRun] does not support it. In the rare
; case where a different admin uninstalls, a Run value pointing at the deleted
; exe survives; Windows ignores entries whose target is missing, so the cost is
; a stale registry string rather than a broken login.
Filename: "{sys}\reg.exe"; \
  Parameters: "delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Run"" /v PCRemote /f"; \
  Flags: runhidden; RunOnceId: "RemoveAutostart"

[UninstallDelete]
; The unpacked copy of the web client. Regenerated on demand, so leaving it
; behind would just be litter.
Type: filesandordirs; Name: "{localappdata}\PCRemote"

[Code]
{
  The app has no window of its own -- it lives in the notification area -- so
  Inno's usual "close the application" prompt has nothing to point at and the
  user would not know what to close. Stopping it outright is both quieter and
  more reliable, and it has no unsaved state to lose.
}
procedure StopRunningApp;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /im {#AppExe}', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningApp;
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningApp;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ConfigDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    { Pairings and the PIN. Asked about rather than assumed: someone
      reinstalling wants to keep their phone paired, and someone leaving wants
      nothing left behind. }
    ConfigDir := ExpandConstant('{userappdata}\pc-remote');
    if DirExists(ConfigDir) then
    begin
      if MsgBox('Remove your PC Remote settings and paired devices?' + #13#10 +
                'Choose No if you plan to reinstall.',
                mbConfirmation, MB_YESNO) = IDYES then
        DelTree(ConfigDir, True, True, True);
    end;
  end;
end;
