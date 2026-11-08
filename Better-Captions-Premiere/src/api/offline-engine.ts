// Offline captioning: mixes the active sequence's audio at its timeline
// positions with ffmpeg, then transcribes it locally with whisper.cpp.
// Everything runs as a detached background job so Premiere stays responsive;
// the panel polls the job's status.json for progress.

import { premierepro, uxp } from "../globals";
import { getAddon } from "./utils/addon";
import {
  FFMPEG_WIN_BYTES,
  FFMPEG_WIN_URL,
  MAC_BIN_DIRS,
  MIX_ARGS,
  MODEL_BASE_URL,
  OFFLINE_MODELS,
  WHISPER_WIN_BYTES,
  WHISPER_WIN_URL,
  VAD_MODEL_BYTES,
  VAD_MODEL_FILE,
  VAD_MODEL_URL,
  extractArgs,
  isValidLanguage,
  parseSpeechSpans,
  whisperArgs,
  type OfflineEngineStatus,
  type OfflineJobStatus,
  type TimelineAudioClip,
} from "./utils/engine-shared";

export { OFFLINE_MODELS };
export type { OfflineEngineStatus, OfflineJobStatus };

const WIN_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WIN_CMD = "C:\\Windows\\System32\\cmd.exe";


// ---------- file helpers ----------

const lfs = () => uxp.storage.localFileSystem;

async function getChild(parent: any, name: string, create = false): Promise<any | null> {
  try {
    return await parent.getEntry(name);
  } catch {
    if (!create) return null;
    return await parent.createFolder(name);
  }
}

async function getDataSubfolder(...names: string[]) {
  let folder: any = await lfs().getDataFolder();
  for (const name of names) folder = await getChild(folder, name, true);
  return folder;
}

async function readText(folder: any, name: string): Promise<string | null> {
  try {
    const file = await folder.getEntry(name);
    return (await file.read()) as string;
  } catch {
    return null;
  }
}

async function writeText(folder: any, name: string, text: string) {
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(text);
  return file;
}

async function isWindows() {
  const data: any = await lfs().getDataFolder();
  return /^[A-Za-z]:\\/.test(data.nativePath);
}

function joinNative(win: boolean, ...parts: string[]) {
  const sep = win ? "\\" : "/";
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""))).join(sep);
}

// ---------- quoting ----------

// PowerShell treats the curly quote variants as single quotes too, so double them all.
const psq = (s: string) => `'${s.replace(/['‘’‚‛]/g, (m) => m + m)}'`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const winArg = (s: string) => (s === "" || /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function toBase64Utf16(str: string) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes.push(code & 0xff, code >> 8);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? chars[n & 63] : "=";
  }
  return out;
}

// ---------- engine discovery ----------

async function getEnginePaths() {
  const win = await isWindows();
  const engine: any = await getDataSubfolder("engine");
  const root: string = engine.nativePath;
  const modelPath = (key: string) => joinNative(win, root, "models", OFFLINE_MODELS[key].file);
  const vadModel = joinNative(win, root, "models", VAD_MODEL_FILE);

  if (win) {
    return {
      win,
      root,
      whisper: joinNative(win, root, "bin", "whisper-cli.exe"),
      ffmpeg: joinNative(win, root, "ffmpeg", "ffmpeg.exe"),
      modelPath,
      vadModel,
    };
  }

  const addon = getAddon();
  const findMac = (name: string) => {
    if (!addon) return "";
    for (const dir of MAC_BIN_DIRS) {
      try {
        const out = addon.execSync(`test -x "${dir}/${name}" && echo found`);
        if (out.trim() === "found") return `${dir}/${name}`;
      } catch {}
    }
    return "";
  };
  return { win, root, whisper: findMac("whisper-cli"), ffmpeg: findMac("ffmpeg"), modelPath, vadModel };
}

async function engineFileExists(...names: string[]) {
  let folder: any = await getDataSubfolder("engine");
  for (const name of names) {
    folder = await getChild(folder, name);
    if (!folder) return false;
  }
  return true;
}

export const getOfflineEngineStatus = async (): Promise<OfflineEngineStatus> => {
  const paths = await getEnginePaths();
  const platform = paths.win ? "win" : "mac";
  const available = !!getAddon()?.execSync;

  const models: string[] = [];
  for (const key of Object.keys(OFFLINE_MODELS)) {
    if (await engineFileExists("models", OFFLINE_MODELS[key].file)) models.push(key);
  }

  const whisper = paths.win ? await engineFileExists("bin", "whisper-cli.exe") : !!paths.whisper;
  const ffmpeg = paths.win ? await engineFileExists("ffmpeg", "ffmpeg.exe") : !!paths.ffmpeg;
  const vad = await engineFileExists("models", VAD_MODEL_FILE);

  let message: string | undefined;
  if (!available) message = "The plugin's native helper did not load, so offline captions can't run.";
  else if (!paths.win && (!whisper || !ffmpeg))
    message = "Install the engine with Homebrew first: brew install whisper-cpp ffmpeg";

  return {
    available,
    platform,
    whisper,
    ffmpeg,
    vad,
    models,
    ready: available && whisper && ffmpeg && vad && models.length > 0,
    enginePath: paths.root,
    message,
  };
};

// ---------- timeline audio ----------

async function getTimelineAudioClips() {
  const project = await premierepro.Project.getActiveProject();
  const sequence = project && (await project.getActiveSequence());
  if (!sequence) throw new Error("Open a sequence first.");

  const duration = (await sequence.getEndTime()).seconds;
  const clipType = (premierepro.Constants as any)?.TrackItemType?.CLIP ?? 1;
  const clips: TimelineAudioClip[] = [];
  const skipped: string[] = [];

  const trackCount = await sequence.getAudioTrackCount();
  for (let t = 0; t < trackCount; t++) {
    const track = await sequence.getAudioTrack(t);
    if (!track || (await track.isMuted())) continue;

    const items: any[] = await track.getTrackItems(clipType, false);
    for (const item of items) {
      if (await item.isDisabled()) continue;

      const projectItem = await item.getProjectItem();
      const name = projectItem?.name || "Untitled clip";
      let path = "";
      try {
        path = await premierepro.ClipProjectItem.cast(projectItem).getMediaFilePath();
      } catch {}
      if (!path) {
        skipped.push(`${name} (nested sequence or no media file)`);
        continue;
      }

      const start = (await item.getStartTime()).seconds;
      const end = (await item.getEndTime()).seconds;
      if (end <= start) continue;

      let speed = 1;
      let reversed = false;
      try {
        speed = Math.abs(await item.getSpeed()) || 1;
        reversed = !!(await item.isSpeedReversed());
      } catch {}

      const inPoint = (await item.getInPoint()).seconds;
      const outPoint = (await item.getOutPoint()).seconds;
      let sourceIn = Math.min(inPoint, outPoint);
      let sourceDuration = Math.abs(outPoint - inPoint);
      if (!(sourceDuration > 0)) sourceDuration = (end - start) * speed;
      sourceIn = Math.max(0, sourceIn);

      clips.push({ name, path, start, end, sourceIn, sourceDuration, speed, reversed });
    }
  }

  return { clips, skipped, duration };
}

// ---------- script generation: Windows (PowerShell) ----------

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Set-Location -LiteralPath $job",
  "$script:stepNo = 0",
  "function Set-Status([string]$state, [string]$stage, [int]$progress = -1, [string]$log = '', [string]$message = '') {",
  "  $o = [ordered]@{ state = $state; stage = $stage; progress = $progress; log = $log; message = $message } | ConvertTo-Json -Compress",
  "  [IO.File]::WriteAllText((Join-Path $job 'status.tmp'), $o)",
  "  Move-Item -Force -LiteralPath (Join-Path $job 'status.tmp') -Destination (Join-Path $job 'status.json')",
  "}",
  "function Test-Cancel { Test-Path -LiteralPath (Join-Path $job 'cancel.flag') }",
  "function Invoke-Step([string]$stage, [string]$exe, [string]$argString, [string]$message, [switch]$Optional) {",
  "  $script:stepNo++",
  "  $log = \"step-$($script:stepNo).log\"",
  "  Set-Status 'running' $stage -1 $log $message",
  "  $p = Start-Process -FilePath $exe -ArgumentList $argString -WorkingDirectory $job -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $job \"step-$($script:stepNo).out\") -RedirectStandardError (Join-Path $job $log)",
  "  $null = $p.Handle",
  "  while (-not $p.HasExited) {",
  "    if (Test-Cancel) { try { $p.Kill() } catch {}; Set-Status 'cancelled' $stage -1 $log 'Cancelled'; exit 1 }",
  "    Start-Sleep -Milliseconds 400",
  "  }",
  "  $p.WaitForExit()",
  "  if ($p.ExitCode -ne 0) {",
  "    if ($Optional) { return $false }",
  "    Set-Status 'error' $stage -1 $log \"$message failed (exit code $($p.ExitCode))\"",
  "    exit 1",
  "  }",
  "  return $true",
  "}",
];

function psTranscribeScript(job: string, ffmpeg: string, whisper: string, model: string, language: string, clips: TimelineAudioClip[], duration: number, vadModel: string) {
  const winJoin = (args: string[]) => args.map(winArg).join(" ");
  const clipLines = clips.map(
    (clip, n) =>
      `  @{ n = ${n}; delay = ${Math.round(clip.start * 1000)}; name = ${psq(clip.name)}; args = ${psq(winJoin(extractArgs(clip, n)))} }`,
  );
  return [
    `$job = ${psq(job)}`,
    ...PS_PRELUDE,
    "try {",
    `  $ffmpeg = ${psq(ffmpeg)}`,
    `  $whisper = ${psq(whisper)}`,
    `  $duration = '${duration.toFixed(3)}'`,
    "  $clips = @(",
    clipLines.join(",\n"),
    "  )",
    "  $ok = @(); $i = 0",
    "  foreach ($c in $clips) {",
    "    $i++",
    "    if (Invoke-Step 'extract' $ffmpeg $c.args \"Extracting audio $i of $($clips.Count)\" -Optional) { $ok += $c }",
    "    else { Add-Content -LiteralPath (Join-Path $job 'warnings.txt') -Value $c.name }",
    "  }",
    "  if ($ok.Count -eq 0) { Set-Status 'error' 'extract' -1 \"step-$($script:stepNo).log\" 'No usable audio was found on the timeline.'; exit 1 }",
    "  $parts = @(); $labels = ''",
    "  for ($k = 0; $k -lt $ok.Count; $k++) { $c = $ok[$k]; $parts += \"amovie=c$($c.n).wav,adelay=$($c.delay):all=1[a$k]\"; $labels += \"[a$k]\" }",
    "  $filter = ($parts -join ';') + ';' + $labels + \"amix=inputs=$($ok.Count):normalize=0:dropout_transition=0,apad=whole_dur=$duration,atrim=end=$duration[out]\"",
    "  [IO.File]::WriteAllText((Join-Path $job 'mix.txt'), $filter)",
    `  $null = Invoke-Step 'mix' $ffmpeg ${psq(winJoin(MIX_ARGS))} 'Mixing timeline audio'`,
    "  $threads = [Math]::Max(1, [Math]::Min(8, [Environment]::ProcessorCount))",
    `  $null = Invoke-Step 'transcribe' $whisper (${psq(winJoin(whisperArgs(model, language, vadModel)))} + ' -t ' + $threads) 'Transcribing speech'`,
    "  Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $job '*.wav')",
    "  Set-Status 'done' 'done' 100",
    "} catch { Set-Status 'error' 'script' -1 '' $_.Exception.Message; exit 1 }",
  ].join("\r\n");
}

function psSetupScript(job: string, engine: string, modelKey: string) {
  const model = OFFLINE_MODELS[modelKey];
  return [
    `$job = ${psq(job)}`,
    `$engine = ${psq(engine)}`,
    ...PS_PRELUDE,
    "function Get-Download([string]$stage, [string]$url, [string]$out, [double]$expected, [string]$label) {",
    "  $script:stepNo++",
    "  $log = \"step-$($script:stepNo).log\"",
    "  Set-Status 'running' $stage 0 $log \"Downloading $label\"",
    "  $curl = Join-Path $env:SystemRoot 'System32\\curl.exe'",
    "  $p = Start-Process -FilePath $curl -ArgumentList ('-L --fail --retry 3 -sS -o \"' + $out + '\" \"' + $url + '\"') -WorkingDirectory $job -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $job \"step-$($script:stepNo).out\") -RedirectStandardError (Join-Path $job $log)",
    "  $null = $p.Handle",
    "  while (-not $p.HasExited) {",
    "    if (Test-Cancel) { try { $p.Kill() } catch {}; Set-Status 'cancelled' $stage -1 $log 'Cancelled'; exit 1 }",
    "    $len = 0",
    "    if (Test-Path -LiteralPath $out) { $len = (Get-Item -LiteralPath $out).Length }",
    "    $mb = [Math]::Round($len / 1MB)",
    "    $pct = [int][Math]::Min(99, 100 * $len / $expected)",
    "    Set-Status 'running' $stage $pct $log \"Downloading $label ($mb MB)\"",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "  $p.WaitForExit()",
    "  if ($p.ExitCode -ne 0) { Set-Status 'error' $stage -1 $log \"Downloading $label failed (curl exit code $($p.ExitCode)). Check your internet connection and try again.\"; exit 1 }",
    "}",
    "try {",
    "  foreach ($d in 'bin', 'ffmpeg', 'models') { New-Item -ItemType Directory -Force -Path (Join-Path $engine $d) | Out-Null }",
    "  if (-not (Test-Path -LiteralPath (Join-Path $engine 'bin\\whisper-cli.exe'))) {",
    `    Get-Download 'whisper' ${psq(WHISPER_WIN_URL)} (Join-Path $job 'whisper.zip') ${WHISPER_WIN_BYTES} 'speech engine'`,
    "    Set-Status 'running' 'whisper' -1 '' 'Unpacking speech engine'",
    "    Expand-Archive -LiteralPath (Join-Path $job 'whisper.zip') -DestinationPath (Join-Path $job 'whisper') -Force",
    "    $cli = Get-ChildItem -LiteralPath (Join-Path $job 'whisper') -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1",
    "    if (-not $cli) { throw 'whisper-cli.exe was not found in the speech engine download.' }",
    "    Copy-Item -Path (Join-Path $cli.DirectoryName '*') -Destination (Join-Path $engine 'bin') -Recurse -Force",
    "  }",
    "  if (-not (Test-Path -LiteralPath (Join-Path $engine 'ffmpeg\\ffmpeg.exe'))) {",
    `    Get-Download 'ffmpeg' ${psq(FFMPEG_WIN_URL)} (Join-Path $job 'ffmpeg.zip') ${FFMPEG_WIN_BYTES} 'audio tools (ffmpeg)'`,
    "    Set-Status 'running' 'ffmpeg' -1 '' 'Unpacking audio tools'",
    "    Expand-Archive -LiteralPath (Join-Path $job 'ffmpeg.zip') -DestinationPath (Join-Path $job 'ffmpeg') -Force",
    "    $ff = Get-ChildItem -LiteralPath (Join-Path $job 'ffmpeg') -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1",
    "    if (-not $ff) { throw 'ffmpeg.exe was not found in the audio tools download.' }",
    "    Copy-Item -LiteralPath $ff.FullName -Destination (Join-Path $engine 'ffmpeg\\ffmpeg.exe') -Force",
    "  }",
    `  $vadFile = Join-Path $engine ${psq("models\\" + VAD_MODEL_FILE)}`,
    "  if (-not (Test-Path -LiteralPath $vadFile)) {",
    `    Get-Download 'vad' ${psq(VAD_MODEL_URL)} ($vadFile + '.part') ${VAD_MODEL_BYTES} 'speech detector'`,
    "    Move-Item -Force -LiteralPath ($vadFile + '.part') -Destination $vadFile",
    "  }",
    `  $modelFile = Join-Path $engine ${psq("models\\" + model.file)}`,
    "  if (-not (Test-Path -LiteralPath $modelFile)) {",
    `    Get-Download 'model' ${psq(MODEL_BASE_URL + model.file)} ($modelFile + '.part') ${model.bytes} 'speech model'`,
    "    Move-Item -Force -LiteralPath ($modelFile + '.part') -Destination $modelFile",
    "  }",
    "  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path (Join-Path $job 'whisper'), (Join-Path $job 'ffmpeg'), (Join-Path $job '*.zip')",
    "  Set-Status 'done' 'done' 100",
    "} catch { Set-Status 'error' 'setup' -1 '' $_.Exception.Message; exit 1 }",
  ].join("\r\n");
}

// ---------- script generation: macOS (sh) ----------

const SH_PRELUDE = [
  "#!/bin/sh",
  'cd "$JOB" || exit 1',
  "STEP=0",
  "set_status() {",
  `  printf '{"state":"%s","stage":"%s","progress":%s,"log":"%s","message":"%s"}' "$1" "$2" "$3" "$4" "$5" > status.tmp && mv -f status.tmp status.json`,
  "}",
  "watch_pid() {",
  "  while kill -0 \"$1\" 2>/dev/null; do",
  "    if [ -f cancel.flag ]; then kill \"$1\" 2>/dev/null; set_status cancelled \"$2\" -1 \"$3\" Cancelled; exit 1; fi",
  "    sleep 0.4",
  "  done",
  "}",
  "run_step() {",
  "  optional=$1; stage=$2; message=$3; shift 3",
  "  STEP=$((STEP+1)); log=\"step-$STEP.log\"",
  "  set_status running \"$stage\" -1 \"$log\" \"$message\"",
  "  \"$@\" > \"step-$STEP.out\" 2> \"$log\" &",
  "  pid=$!",
  "  watch_pid \"$pid\" \"$stage\" \"$log\"",
  "  wait \"$pid\"; rc=$?",
  "  if [ \"$rc\" -ne 0 ]; then",
  "    if [ \"$optional\" = 1 ]; then return 1; fi",
  "    set_status error \"$stage\" -1 \"$log\" \"$message failed (exit code $rc)\"; exit 1",
  "  fi",
  "  return 0",
  "}",
];

function shTranscribeScript(job: string, ffmpeg: string, whisper: string, model: string, language: string, clips: TimelineAudioClip[], duration: number, vadModel: string) {
  const shJoin = (args: string[]) => args.map(shq).join(" ");
  const clipLines = clips.map((clip, n) => {
    const delay = Math.round(clip.start * 1000);
    return [
      `if run_step 1 extract ${shq(`Extracting audio ${n + 1} of ${clips.length}`)} "$FFMPEG" ${shJoin(extractArgs(clip, n))}; then`,
      `  FILTER="$FILTER" ; FILTER="\${FILTER}amovie=c${n}.wav,adelay=${delay}:all=1[a$OK];" ; LABELS="\${LABELS}[a$OK]" ; OK=$((OK+1))`,
      `else printf '%s\\n' ${shq(clip.name)} >> warnings.txt; fi`,
    ].join("\n");
  });
  const d = duration.toFixed(3);
  return [
    `JOB=${shq(job)}`,
    ...SH_PRELUDE,
    `FFMPEG=${shq(ffmpeg)}`,
    `WHISPER=${shq(whisper)}`,
    'FILTER=""; LABELS=""; OK=0',
    ...clipLines,
    'if [ "$OK" -eq 0 ]; then set_status error extract -1 "step-$STEP.log" "No usable audio was found on the timeline."; exit 1; fi',
    `printf '%s' "\${FILTER}\${LABELS}amix=inputs=\${OK}:normalize=0:dropout_transition=0,apad=whole_dur=${d},atrim=end=${d}[out]" > mix.txt`,
    `run_step 0 mix 'Mixing timeline audio' "$FFMPEG" ${shJoin(MIX_ARGS)}`,
    "THREADS=$(sysctl -n hw.ncpu 2>/dev/null || echo 4); [ \"$THREADS\" -gt 8 ] && THREADS=8",
    `run_step 0 transcribe 'Transcribing speech' "$WHISPER" ${shJoin(whisperArgs(model, language, vadModel))} -t "$THREADS"`,
    "rm -f ./*.wav",
    'set_status done done 100 "" ""',
  ].join("\n");
}

function shSetupScript(job: string, engine: string, modelKey: string) {
  const model = OFFLINE_MODELS[modelKey];
  const out = `${engine}/models/${model.file}`;
  return [
    `JOB=${shq(job)}`,
    ...SH_PRELUDE,
    `OUT=${shq(out)}`,
    `VAD=${shq(`${engine}/models/${VAD_MODEL_FILE}`)}`,
    'mkdir -p "$(dirname "$OUT")"',
    'if [ ! -f "$VAD" ]; then',
    '  set_status running vad -1 step-0.log "Downloading speech detector"',
    `  curl -L --fail --retry 3 -sS -o "$VAD.part" ${shq(VAD_MODEL_URL)} > step-0.out 2> step-0.log && mv -f "$VAD.part" "$VAD" || { set_status error vad -1 step-0.log "Downloading the speech detector failed. Check your internet connection and try again."; exit 1; }`,
    "fi",
    '[ -f "$OUT" ] && { set_status done done 100 "" ""; exit 0; }',
    'set_status running model 0 step-1.log "Downloading speech model"',
    `curl -L --fail --retry 3 -sS -o "$OUT.part" ${shq(MODEL_BASE_URL + model.file)} > step-1.out 2> step-1.log &`,
    "pid=$!",
    'while kill -0 "$pid" 2>/dev/null; do',
    '  if [ -f cancel.flag ]; then kill "$pid" 2>/dev/null; set_status cancelled model -1 step-1.log Cancelled; exit 1; fi',
    '  len=$(stat -f%z "$OUT.part" 2>/dev/null || echo 0)',
    `  pct=$((len * 100 / ${model.bytes})); [ "$pct" -gt 99 ] && pct=99`,
    '  set_status running model "$pct" step-1.log "Downloading speech model ($((len / 1048576)) MB)"',
    "  sleep 0.5",
    "done",
    'wait "$pid" || { set_status error model -1 step-1.log "Downloading the speech model failed. Check your internet connection and try again."; exit 1; }',
    'mv -f "$OUT.part" "$OUT"',
    'set_status done done 100 "" ""',
  ].join("\n");
}

// ---------- job control ----------

async function createJob(kind: string) {
  const id = `${kind}-${Date.now().toString(36)}`;
  const jobs: any = await getDataSubfolder("jobs");
  const folder: any = await jobs.createFolder(id);
  return { id, folder, path: folder.nativePath as string };
}

async function launchScript(win: boolean, folder: any, content: string) {
  const addon = getAddon();
  if (!addon?.execSync) throw new Error("The plugin's native helper did not load.");

  if (win) {
    // BOM so Windows PowerShell 5.1 reads non-ASCII paths as UTF-8.
    const file = await writeText(folder, "run.ps1", "\uFEFF" + content);
    const inner =
      `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList ` +
      `'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + ${psq(file.nativePath)} + '"')`;
    addon.execSync(
      `${WIN_POWERSHELL} -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${toBase64Utf16(inner)}`,
    );
  } else {
    const file = await writeText(folder, "run.sh", content);
    addon.execSync(`nohup /bin/sh ${shq(file.nativePath)} >/dev/null 2>&1 &`);
  }
}

async function getJobFolder(jobId: string) {
  if (!/^[a-z]+-[a-z0-9]+$/.test(jobId)) return null;
  const jobs: any = await getDataSubfolder("jobs");
  return getChild(jobs, jobId);
}

export const startOfflineEngineSetup = async (modelKey: string) => {
  try {
    if (!OFFLINE_MODELS[modelKey]) throw new Error(`Unknown model "${modelKey}".`);
    const paths = await getEnginePaths();
    if (!paths.win && (!paths.whisper || !paths.ffmpeg)) {
      throw new Error("Install the engine with Homebrew first: brew install whisper-cpp ffmpeg");
    }
    const job = await createJob("setup");
    const script = paths.win
      ? psSetupScript(job.path, paths.root, modelKey)
      : shSetupScript(job.path, paths.root, modelKey);
    await launchScript(paths.win, job.folder, script);
    return { success: true, jobId: job.id };
  } catch (e: any) {
    console.error("startOfflineEngineSetup failed:", e);
    return { success: false, error: e?.message || String(e) };
  }
};

export const startOfflineTranscription = async (modelKey: string, language: string) => {
  try {
    if (!OFFLINE_MODELS[modelKey]) throw new Error(`Unknown model "${modelKey}".`);
    if (!isValidLanguage(language)) throw new Error(`Unknown language "${language}".`);

    const status = await getOfflineEngineStatus();
    if (!status.ready || !status.models.includes(modelKey)) {
      throw new Error("The offline engine isn't set up yet for this model.");
    }

    const { clips, skipped, duration } = await getTimelineAudioClips();
    if (clips.length === 0) {
      throw new Error("No audio clips were found on unmuted audio tracks in this sequence.");
    }

    const paths = await getEnginePaths();
    const job = await createJob("transcribe");
    const model = paths.modelPath(modelKey);
    const script = paths.win
      ? psTranscribeScript(job.path, paths.ffmpeg, paths.whisper, model, language, clips, duration, paths.vadModel)
      : shTranscribeScript(job.path, paths.ffmpeg, paths.whisper, model, language, clips, duration, paths.vadModel);
    await launchScript(paths.win, job.folder, script);

    return { success: true, jobId: job.id, clipCount: clips.length, skipped };
  } catch (e: any) {
    console.error("startOfflineTranscription failed:", e);
    return { success: false, error: e?.message || String(e) };
  }
};

export const getOfflineJobStatus = async (jobId: string): Promise<OfflineJobStatus> => {
  const folder = await getJobFolder(jobId);
  if (!folder) return { state: "error", stage: "", progress: -1, message: "Job not found." };

  const raw = await readText(folder, "status.json");
  if (!raw) return { state: "starting", stage: "", progress: -1, message: "Starting…" };

  let status: any;
  try {
    status = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return { state: "running", stage: "", progress: -1, message: "Working…" };
  }

  const result: OfflineJobStatus = {
    state: status.state,
    stage: status.stage,
    progress: typeof status.progress === "number" ? status.progress : -1,
    message: status.message || "",
  };

  if (status.log && (status.stage === "transcribe" || status.state === "error")) {
    const log = await readText(folder, status.log);
    if (log && status.stage === "transcribe" && status.state === "running") {
      const matches = [...log.matchAll(/progress =\s*(\d+)%/g)];
      if (matches.length) result.progress = Number(matches[matches.length - 1][1]);
    }
    if (log && status.state === "error") {
      result.logTail = log.trim().split(/\r?\n/).slice(-6).join("\n");
    }
  }
  return result;
};

export const cancelOfflineJob = async (jobId: string) => {
  const folder = await getJobFolder(jobId);
  if (folder) await writeText(folder, "cancel.flag", "1");
  return true;
};

export const readOfflineTranscriptionResult = async (jobId: string) => {
  const folder = await getJobFolder(jobId);
  if (!folder) return { success: false, error: "Job not found." };

  const json = await readText(folder, "result.json");
  if (!json) return { success: false, error: "The transcription finished without a result file." };
  const warnings = (await readText(folder, "warnings.txt")) || "";

  // Transcription is the last step, so its log (with the detected speech spans) is the highest-numbered one.
  let speechSpans: ReturnType<typeof parseSpeechSpans> = [];
  try {
    const entries: any[] = await folder.getEntries();
    const logs = entries
      .map((e) => /^step-(\d+)\.log$/.exec(e.name))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    if (logs.length) speechSpans = parseSpeechSpans((await readText(folder, logs[0][0])) || "");
  } catch {}

  await removeJobFolder(folder.nativePath);
  return {
    success: true,
    json,
    skipped: warnings.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    speechSpans,
    offset: 0,
  };
};

async function removeJobFolder(nativePath: string) {
  try {
    const addon = getAddon();
    if (!addon?.execSync) return;
    if (await isWindows()) addon.execSync(`${WIN_CMD} /C rmdir /s /q "${nativePath}"`);
    else addon.execSync(`rm -rf ${shq(nativePath)}`);
  } catch (e) {
    console.warn("removeJobFolder failed:", e);
  }
}

// ---------- saved offline transcripts (per sequence) ----------

const transcriptFileName = (sequenceId: string) =>
  `${sequenceId.replace(/[^A-Za-z0-9-]/g, "_")}.json`;

export const saveOfflineTranscript = async (sequenceId: string, json: string) => {
  const folder: any = await getDataSubfolder("transcripts");
  await writeText(folder, transcriptFileName(sequenceId), json);
  return true;
};

export const loadOfflineTranscript = async (sequenceId: string): Promise<string | null> => {
  const folder: any = await getDataSubfolder("transcripts");
  return readText(folder, transcriptFileName(sequenceId));
};

export const deleteOfflineTranscript = async (sequenceId: string) => {
  const folder: any = await getDataSubfolder("transcripts");
  try {
    const file = await folder.getEntry(transcriptFileName(sequenceId));
    await file.delete();
  } catch {}
  return true;
};
