' Slidecraft.vbs — double-click launcher, no console window.
' Starts the server (if not already running) and opens the app in your browser.
' Resolves node.exe robustly (common install locations + PATH) so it works when
' launched from Explorer, whose PATH can differ from a terminal's.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root

' find node.exe: prefer known install dirs, fall back to PATH lookup ("node")
node = ""
candidates = Array( _
  "C:\Program Files\nodejs\node.exe", _
  "C:\Program Files (x86)\nodejs\node.exe", _
  shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
  shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe") )
For Each c In candidates
  If node = "" And fso.FileExists(c) Then node = c
Next
If node = "" Then node = "node.exe"  ' last resort: rely on PATH

shell.Run """" & node & """ """ & root & "\scripts\launch.js""", 0, False
