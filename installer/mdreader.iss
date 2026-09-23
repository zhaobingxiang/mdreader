; mdreader 安装程序
; 编译：ISCC.exe installer\mdreader.iss

#define MyAppName "mdreader"
#define MyAppVersion "1.26.0903.01"
#define MyAppPublisher "mdreader"
#define MyAppExeName "mdreader.exe"

[Setup]
AppId={{8F3C2A10-6B7E-4D91-9C2A-5E7F1D3B4A68}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=..\release
OutputBaseFilename=mdreader-{#MyAppVersion}-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; 注意：本机企业安全软件拦截了 EndUpdateResource，一旦设置自定义 SetupIconFile，
; 编译会在「Updating icons (Setup.e32)」阶段报 110 错误。
; 安装程序沿用 Inno 默认图标；mdreader.exe 自身的图标由 .NET 编译器写入，不受影响。
; 如需安装程序也用自定义图标，请在有权限的机器上编译，或为该目录加白名单。
; SetupIconFile=..\assets\mdreader.ico
; 默认按当前用户安装，不需要管理员权限
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableWelcomePage=no
AllowNoIcons=yes
; 关闭"是否继续"之类的多余确认
DisableDirPage=no
UsePreviousAppDir=yes

[Languages]
Name: "cn"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式:"; Flags: checkedonce
Name: "associate"; Description: "关联 .md 文件，双击用 mdreader 打开"; GroupDescription: "文件关联:"; Flags: checkedonce

[Files]
Source: "..\desktop\publish\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\desktop\publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.pdb"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; .md 文件关联（HKA 会按安装模式自动选择 HKLM 或 HKCU）
Root: HKA; Subkey: "Software\Classes\.md"; ValueType: string; ValueName: ""; ValueData: "mdreader.Document"; Flags: uninsdeletevalue; Tasks: associate
Root: HKA; Subkey: "Software\Classes\mdreader.Document"; ValueType: string; ValueName: ""; ValueData: "Markdown 文档"; Flags: uninsdeletekey; Tasks: associate
Root: HKA; Subkey: "Software\Classes\mdreader.Document\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Tasks: associate
Root: HKA; Subkey: "Software\Classes\mdreader.Document\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: associate
; 可选：把「打开方式」里的友好名称也一起注册
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: associate
Root: HKA; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""; Tasks: associate

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function WebView2Version(out Version: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);

  // 注册表没有时退一步：看运行时目录是否存在（新版 Edge 不一定写上述键）
  if not Result then
  begin
    Result := FindFirst(ExpandConstant('{commonpf32}\Microsoft\EdgeWebView\Application\*'), FindRec);
    if Result then
    begin
      Version := 'installed';
      FindClose(FindRec);
    end;
  end;
end;

function InitializeSetup(): Boolean;
var
  Version: String;
begin
  Result := True;

  // 静默安装不做任何交互，避免 /VERYSILENT 下被消息框中断
  if WizardSilent then
    Exit;

  if not WebView2Version(Version) then
  begin
    if MsgBox('本程序依赖 Microsoft Edge WebView2 运行时，当前系统未检测到。' + #13#10#13#10 +
              'Windows 10/11 一般已预装；若未安装，请先安装 WebView2 Runtime 再使用。' + #13#10#13#10 +
              '仍要继续安装吗？', mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;
