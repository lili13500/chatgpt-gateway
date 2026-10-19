Option Explicit
Dim fs, sh, root, part, nodePath, possible, command, probe
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)

' One click is idempotent. Reusing the live service avoids a second process.
On Error Resume Next
Set probe = CreateObject("MSXML2.ServerXMLHTTP.6.0")
probe.setTimeouts 250, 250, 250, 250
probe.Open "GET", "http://127.0.0.1:18080/health", False
probe.Send
If Err.Number = 0 Then
    If probe.Status = 200 Then
        If InStr(probe.responseText, "chatgpt-web-extension") > 0 Then WScript.Quit 0
    End If
End If
Err.Clear
On Error GoTo 0

nodePath = ""
For Each part In Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
    If Len(part) > 0 Then
        possible = fs.BuildPath(part, "node.exe")
        If fs.FileExists(possible) Then
            nodePath = possible
            Exit For
        End If
    End If
Next
If nodePath = "" Then WScript.Quit 2
sh.CurrentDirectory = root
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & fs.BuildPath(root, "server.mjs") & Chr(34)
sh.Run command, 0, False
