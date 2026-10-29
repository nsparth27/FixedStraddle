Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node """ & Replace(WScript.ScriptFullName, "start-auto-sync-silent.vbs", "watch-sync.js") & """", 0, False
