Option Explicit
Dim fs, sh, root, browser, url, q
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
sh.Run q & sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe" & q & " //B " & q & fs.BuildPath(root, "start-hidden.vbs") & q, 0, True
browser = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
If Not fs.FileExists(browser) Then WScript.Quit 2
url = "http://127.0.0.1:18080/"
If WScript.Arguments.Count > 0 Then
    If WScript.Arguments(0) = "setup" Then url = "http://127.0.0.1:18080/chatgpt-gateway.user.js"
End If
' Default is the profile verified to contain the user's Tampermonkey install.
' No browser security flags, profile copying or account changes.
sh.Run q & browser & q & " --profile-directory=Default --new-tab " & q & url & q, 1, False
