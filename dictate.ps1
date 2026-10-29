# Dictation for the Chat view's mic button: Windows' modern recognizer (Windows.Media.SpeechRecognition, the engine
# behind voice typing) on the default microphone, no Windows UI. Writes one JSON line per event to stdout:
#   {"t":"ready"}  listening      {"t":"hyp","text":"…"}  the phrase so far      {"t":"final","text":"…"}  a settled phrase
#   {"t":"error","text":"…","privacy":true}  privacy: Windows' "Online speech recognition" is off
# Runs until main.js kills it. PowerShell 5.1 can't subscribe to WinRT events, so a small C# class does, compiled once
# by the csc that ships with Windows and cached in %TEMP% by a hash of its source.
$ErrorActionPreference = 'Stop'
function Say($t, $text, $privacy) { $o = @{ t = $t; text = $text }; if ($privacy) { $o.privacy = $true }; [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
$src = @'
using System; using System.Collections.Concurrent; using System.Threading; using Windows.Foundation; using Windows.Media.SpeechRecognition;
public static class OverlordDictate {
  public static BlockingCollection<string[]> Q = new BlockingCollection<string[]>();
  static void Wait(IAsyncInfo op) { while (op.Status == AsyncStatus.Started) Thread.Sleep(20); if (op.Status != AsyncStatus.Completed) throw op.ErrorCode ?? new Exception(op.Status.ToString()); }
  public static void Start() {
    var r = new SpeechRecognizer();
    var cop = r.CompileConstraintsAsync(); Wait(cop);
    if (cop.GetResults().Status != SpeechRecognitionResultStatus.Success) throw new Exception("Speech recognizer: " + cop.GetResults().Status);
    r.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromMinutes(10);
    r.HypothesisGenerated += new TypedEventHandler<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>((s, e) => Q.Add(new[] { "hyp", e.Hypothesis.Text }));
    r.ContinuousRecognitionSession.ResultGenerated += new TypedEventHandler<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>((s, e) => Q.Add(new[] { "final", e.Result.Text }));
    r.ContinuousRecognitionSession.Completed += new TypedEventHandler<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>((s, e) => Q.Add(new[] { "done", e.Status.ToString() }));
    Wait(r.ContinuousRecognitionSession.StartAsync());
    Q.Add(new[] { "ready", r.CurrentLanguage.LanguageTag });
  }
}
'@
try {
  $hash = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($src))).Replace('-', '').Substring(0, 12)
  $dll = Join-Path $env:TEMP "overlord-dictate-$hash.dll"
  if (-not (Test-Path $dll)) {
    $fw = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(); $wm = "$env:windir\System32\WinMetadata"
    $cs = Join-Path $env:TEMP "overlord-dictate-$hash.cs"; [IO.File]::WriteAllText($cs, $src)
    $out = & "$($fw)csc.exe" -nologo -target:library "-out:$dll" "-r:$wm\Windows.Media.winmd" "-r:$wm\Windows.Foundation.winmd" "-r:$wm\Windows.Globalization.winmd" "-r:$($fw)System.Runtime.dll" "-r:$($fw)System.Runtime.InteropServices.WindowsRuntime.dll" $cs
    if (-not (Test-Path $dll)) { throw "Couldn't build the speech helper: $out" }
  }
  Add-Type -Path $dll
  [OverlordDictate]::Start()
  while ($true) {
    $m = [OverlordDictate]::Q.Take()
    if ($m[0] -eq 'done') { if ($m[1] -ne 'Success') { Say 'error' "Speech recognizer stopped: $($m[1])" }; exit 0 }
    if ($m[1]) { Say $m[0] $m[1] }
  }
} catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  if ($e.Message -match 'privacy policy') { Say 'error' 'Turn on Online speech recognition in Windows settings' $true } else { Say 'error' $e.Message }
  exit 1
}
