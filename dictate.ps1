# Offline dictation for the Chat view's mic button: Windows' own speech recognizer (System.Speech), the default
# microphone, nothing leaves the machine. Writes one JSON line per event to stdout:
#   {"t":"ready"}  listening      {"t":"hyp","text":"…"}  the phrase so far      {"t":"final","text":"…"}  a settled phrase
#   {"t":"error","text":"…"}  no recognizer or no microphone
# Runs until main.js kills it.
$ErrorActionPreference = 'Stop'
function Say($t, $text) { [Console]::Out.WriteLine((@{ t = $t; text = $text } | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Speech
  $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1
  if (-not $info) { Say 'error' 'No Windows speech recognizer is installed'; exit 1 }
  $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine $info
  $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $r.SetInputToDefaultAudioDevice()
  $null = Register-ObjectEvent $r SpeechHypothesized -SourceIdentifier hyp
  $null = Register-ObjectEvent $r SpeechRecognized -SourceIdentifier rec
  $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Say 'ready' $info.Culture.Name
  while ($true) {
    $e = Wait-Event
    $text = $e.SourceEventArgs.Result.Text
    if ($text) { Say ($(if ($e.SourceIdentifier -eq 'rec') { 'final' } else { 'hyp' })) $text }
    Remove-Event -EventIdentifier $e.EventIdentifier
  }
} catch { Say 'error' $_.Exception.Message; exit 1 }
