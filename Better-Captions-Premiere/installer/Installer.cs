// Better Captions installer: a small Windows app that installs the CEP
// extension (packed inside this .exe as Extension.zip) into the current
// user's Adobe CEP extensions folder. No admin rights needed.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4.8),
// so it's C# 5: see build-installer.ps1.
//
// Command line:
//   BetterCaptionsSetup.exe                 show the installer window
//   BetterCaptionsSetup.exe /silent         install without a window
//   BetterCaptionsSetup.exe /uninstall      uninstall (add /silent for no window)
//   BetterCaptionsSetup.exe /noengine       install the panel only, without downloading
//                                           the speech engine and Large v3 Turbo model
// Testing only: /extdir:"path" installs somewhere else, /noregistry skips registry changes,
// /ignorepremiere skips the "close Premiere first" check, /enginedir:"path" downloads
// the engine somewhere else.
//
// After installing the panel, setup downloads the offline speech engine into
// %APPDATA%\BetterCaptions\engine (the same place the panel looks): whisper.cpp,
// ffmpeg, the Silero speech detector and the Large v3 Turbo model, about 700 MB.
// Parts already downloaded are skipped, and an interrupted download resumes.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Better Captions Setup")]
[assembly: AssemblyProduct("Better Captions for Premiere Pro")]
[assembly: AssemblyDescription("Installs the Better Captions extension for Adobe Premiere Pro")]

namespace BetterCaptionsSetup
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            var options = Options.Parse(args);
            var installer = new ExtensionInstaller(options);

            if (options.Silent)
            {
                try
                {
                    if (options.Uninstall) installer.Uninstall(false);
                    else installer.Install();
                    Console.WriteLine(options.Uninstall ? "Uninstalled." : "Installed to " + installer.TargetDir);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine(e.Message);
                    return 1;
                }
                if (options.Uninstall || options.NoEngine) return 0;
                try
                {
                    var engine = new EngineDownloader(options.EngineDir);
                    int last = -10;
                    engine.Run(delegate(string message, int percent)
                    {
                        if (percent < 0 || percent >= last + 10 || percent == 100)
                        {
                            Console.WriteLine(percent >= 0 ? percent + "% " + message : message);
                            if (percent >= 0) last = percent;
                        }
                    });
                    Console.WriteLine("Speech engine ready in " + engine.Root);
                    return 0;
                }
                catch (Exception e)
                {
                    // The panel is installed; its setup button can finish the download later.
                    Console.Error.WriteLine("The panel is installed, but the speech engine download failed: " + e.Message);
                    return 2;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (options.ScreenshotPath != null)
            {
                // Testing: render the window to a PNG instead of showing it.
                using (var form = new InstallerForm(installer, false))
                using (var bmp = new Bitmap(form.Width, form.Height))
                {
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new Point(-4000, -4000);
                    form.ShowInTaskbar = false;
                    form.Show();
                    Application.DoEvents();
                    form.DrawToBitmap(bmp, new Rectangle(0, 0, form.Width, form.Height));
                    form.Close();
                    bmp.Save(options.ScreenshotPath, System.Drawing.Imaging.ImageFormat.Png);
                }
                return 0;
            }

            Application.Run(new InstallerForm(installer, options.Uninstall));
            return 0;
        }
    }

    class Options
    {
        public bool Silent;
        public bool Uninstall;
        public bool NoRegistry;
        public bool IgnorePremiere;
        public bool NoEngine;
        public string EngineDir;
        public string ExtensionsDir;
        public string ScreenshotPath;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            foreach (var raw in args)
            {
                var a = raw.Trim();
                var lower = a.ToLowerInvariant();
                if (lower == "/silent" || lower == "/s") o.Silent = true;
                else if (lower == "/uninstall" || lower == "/u") o.Uninstall = true;
                else if (lower == "/noregistry") o.NoRegistry = true;
                else if (lower == "/ignorepremiere") o.IgnorePremiere = true;
                else if (lower == "/noengine") o.NoEngine = true;
                else if (lower.StartsWith("/enginedir:")) o.EngineDir = a.Substring(11).Trim('"');
                else if (lower.StartsWith("/extdir:")) o.ExtensionsDir = a.Substring(8).Trim('"');
                else if (lower.StartsWith("/screenshot:")) o.ScreenshotPath = a.Substring(12).Trim('"');
            }
            return o;
        }
    }

    class PremiereRunningException : Exception
    {
        public PremiereRunningException()
            : base("Premiere Pro is open. Close it first, then try again.") { }
    }

    class ExtensionInstaller
    {
        public const string BundleId = "com.bettercaptions.cep";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterCaptions";
        const string DisplayName = "Better Captions for Premiere Pro";

        readonly Options options;

        public ExtensionInstaller(Options options)
        {
            this.options = options;
        }

        public Options Options { get { return options; } }

        static string AppData { get { return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } }
        static string LocalAppData { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }

        public string ExtensionsDir
        {
            get { return options.ExtensionsDir ?? Path.Combine(AppData, @"Adobe\CEP\extensions"); }
        }

        public string TargetDir { get { return Path.Combine(ExtensionsDir, BundleId); } }

        // Speech engine, models and saved captions downloaded by the extension.
        public static string EngineDataDir { get { return Path.Combine(AppData, "BetterCaptions"); } }

        static string SetupCopyDir { get { return Path.Combine(LocalAppData, "BetterCaptions"); } }

        public static bool IsPremiereRunning()
        {
            return Process.GetProcessesByName("Adobe Premiere Pro").Length > 0;
        }

        static Stream OpenPayload()
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Extension.zip");
            if (stream == null) throw new InvalidOperationException("This installer is missing its extension files. Rebuild it.");
            return stream;
        }

        static string ReadVersion(string manifestXml)
        {
            var m = Regex.Match(manifestXml ?? "", "ExtensionBundleVersion=\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : null;
        }

        public string PackagedVersion
        {
            get
            {
                using (var zip = new ZipArchive(OpenPayload(), ZipArchiveMode.Read))
                {
                    var entry = zip.Entries.FirstOrDefault(e => e.FullName.Replace('\\', '/') == "CSXS/manifest.xml");
                    if (entry == null) return null;
                    using (var reader = new StreamReader(entry.Open())) return ReadVersion(reader.ReadToEnd());
                }
            }
        }

        public string InstalledVersion
        {
            get
            {
                var manifest = Path.Combine(TargetDir, @"CSXS\manifest.xml");
                return File.Exists(manifest) ? ReadVersion(File.ReadAllText(manifest)) : null;
            }
        }

        // Returns the CEP versions whose unsigned-extension setting had to be turned on.
        public List<string> Install()
        {
            if (!options.IgnorePremiere && IsPremiereRunning()) throw new PremiereRunningException();

            if (Directory.Exists(TargetDir)) Directory.Delete(TargetDir, true);
            Directory.CreateDirectory(TargetDir);
            ExtractPayload(TargetDir);

            var changed = new List<string>();
            if (!options.NoRegistry)
            {
                changed = EnableUnsignedExtensions();
                RegisterUninstaller();
            }
            return changed;
        }

        void ExtractPayload(string destination)
        {
            var root = Path.GetFullPath(destination).TrimEnd('\\') + "\\";
            using (var zip = new ZipArchive(OpenPayload(), ZipArchiveMode.Read))
            {
                foreach (var entry in zip.Entries)
                {
                    var relative = entry.FullName.Replace('/', '\\');
                    var path = Path.GetFullPath(Path.Combine(root, relative));
                    // Never write outside the extension folder.
                    if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                    if (relative.EndsWith("\\"))
                    {
                        Directory.CreateDirectory(path);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    entry.ExtractToFile(path, true);
                }
            }
        }

        // Premiere loads unsigned extensions only when PlayerDebugMode is "1"
        // for its CEP version (CSXS.12 for Premiere 2025-2026).
        static List<string> EnableUnsignedExtensions()
        {
            var changed = new List<string>();
            for (int v = 9; v <= 16; v++)
            {
                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Adobe\CSXS." + v))
                {
                    if (Convert.ToString(key.GetValue("PlayerDebugMode")) != "1")
                    {
                        key.SetValue("PlayerDebugMode", "1", RegistryValueKind.String);
                        changed.Add("CSXS." + v);
                    }
                }
            }
            return changed;
        }

        // Keeps a copy of this setup program so Windows Settings > Apps can uninstall it.
        void RegisterUninstaller()
        {
            var self = Assembly.GetExecutingAssembly().Location;
            Directory.CreateDirectory(SetupCopyDir);
            var copy = Path.Combine(SetupCopyDir, "BetterCaptionsSetup.exe");
            if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(copy), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(self, copy, true);
            }

            using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", DisplayName);
                key.SetValue("DisplayVersion", PackagedVersion ?? "");
                key.SetValue("Publisher", "Better Captions");
                key.SetValue("DisplayIcon", copy);
                key.SetValue("InstallLocation", TargetDir);
                key.SetValue("UninstallString", "\"" + copy + "\" /uninstall");
                key.SetValue("QuietUninstallString", "\"" + copy + "\" /uninstall /silent");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)(DirectorySize(TargetDir) / 1024), RegistryValueKind.DWord);
            }
        }

        static long DirectorySize(string dir)
        {
            return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
        }

        public void Uninstall(bool removeEngineData)
        {
            if (!options.IgnorePremiere && IsPremiereRunning()) throw new PremiereRunningException();

            if (Directory.Exists(TargetDir)) Directory.Delete(TargetDir, true);
            if (removeEngineData && Directory.Exists(EngineDataDir)) Directory.Delete(EngineDataDir, true);

            if (options.NoRegistry) return;
            // PlayerDebugMode is left alone: other unsigned extensions may rely on it.
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);

            var self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            if (self.StartsWith(Path.GetFullPath(SetupCopyDir), StringComparison.OrdinalIgnoreCase))
            {
                // A running program can't delete itself, so remove the copy just after exiting.
                var cleanup = new ProcessStartInfo("cmd.exe",
                    "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + SetupCopyDir + "\"");
                cleanup.CreateNoWindow = true;
                cleanup.UseShellExecute = false;
                Process.Start(cleanup);
            }
            else if (Directory.Exists(SetupCopyDir))
            {
                Directory.Delete(SetupCopyDir, true);
            }
        }

        public static string FindPremiere()
        {
            var roots = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetEnvironmentVariable("ProgramW6432"),
            };
            var candidates = new List<string>();
            foreach (var root in roots.Where(r => !string.IsNullOrEmpty(r)).Distinct())
            {
                var adobe = Path.Combine(root, "Adobe");
                if (!Directory.Exists(adobe)) continue;
                foreach (var dir in Directory.GetDirectories(adobe, "Adobe Premiere Pro*"))
                {
                    var exe = Path.Combine(dir, "Adobe Premiere Pro.exe");
                    if (File.Exists(exe)) candidates.Add(exe);
                }
            }
            // Newest version folder first ("... 2026" sorts after "... 2025").
            return candidates.OrderByDescending(p => p, StringComparer.OrdinalIgnoreCase).FirstOrDefault();
        }
    }

    // Downloads the offline speech engine the panel uses. The file layout must
    // match webview-ui/src/cep/engine.ts (enginePaths) and the URLs match
    // src/api/utils/engine-shared.ts.
    class EngineDownloader
    {
        const string WhisperUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
        const string FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
        const string VadUrl = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
        const string ModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
        const string VadFile = "ggml-silero-v5.1.2.bin";
        const string ModelFile = "ggml-large-v3-turbo-q5_0.bin";
        const long WhisperBytes = 8194445;
        const long FfmpegBytes = 114768076;
        const long VadBytes = 885098;
        const long ModelBytes = 574041195;

        // Models from older versions of the panel, no longer used.
        static readonly string[] OldModels = { "ggml-base.bin", "ggml-small.bin" };

        public readonly string Root;
        volatile bool cancelled;

        public EngineDownloader(string root)
        {
            Root = root ?? Path.Combine(ExtensionInstaller.EngineDataDir, "engine");
        }

        string WhisperExe { get { return Path.Combine(Root, @"bin\whisper-cli.exe"); } }
        string FfmpegExe { get { return Path.Combine(Root, @"ffmpeg\ffmpeg.exe"); } }
        string ModelsDir { get { return Path.Combine(Root, "models"); } }
        string VadPath { get { return Path.Combine(ModelsDir, VadFile); } }
        string ModelPath { get { return Path.Combine(ModelsDir, ModelFile); } }

        static bool HasFile(string path, long exactBytes)
        {
            if (!File.Exists(path)) return false;
            return exactBytes <= 0 || new FileInfo(path).Length == exactBytes;
        }

        bool NeedWhisper { get { return !File.Exists(WhisperExe); } }
        bool NeedFfmpeg { get { return !File.Exists(FfmpegExe); } }
        bool NeedVad { get { return !HasFile(VadPath, VadBytes); } }
        bool NeedModel { get { return !HasFile(ModelPath, ModelBytes); } }

        public bool IsInstalled { get { return !NeedWhisper && !NeedFfmpeg && !NeedVad && !NeedModel; } }

        // Approximate download size still needed, in bytes.
        public long RemainingBytes
        {
            get
            {
                return (NeedWhisper ? WhisperBytes : 0) + (NeedFfmpeg ? FfmpegBytes : 0)
                    + (NeedVad ? VadBytes : 0) + (NeedModel ? ModelBytes : 0);
            }
        }

        public void Cancel() { cancelled = true; }

        long total, done;
        Action<string, int> report;
        DateTime lastReport = DateTime.MinValue;

        void Report(string message, long stepDone, bool force)
        {
            var now = DateTime.UtcNow;
            if (!force && (now - lastReport).TotalMilliseconds < 200) return;
            lastReport = now;
            int percent = total > 0 ? (int)Math.Min(100, (done + stepDone) * 100 / total) : -1;
            report(message, percent);
        }

        public void Run(Action<string, int> onProgress)
        {
            report = onProgress;
            cancelled = false;
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; // TLS 1.3
            }
            catch (NotSupportedException)
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            }

            Directory.CreateDirectory(ModelsDir);
            foreach (var old in OldModels)
            {
                try { File.Delete(Path.Combine(ModelsDir, old)); File.Delete(Path.Combine(ModelsDir, old + ".part")); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }

            total = RemainingBytes;
            done = 0;
            if (total == 0)
            {
                report("Speech engine already installed.", 100);
                return;
            }

            var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(Root)));
            long needed = total + (NeedFfmpeg ? 200L * 1024 * 1024 : 0) + 100L * 1024 * 1024;
            if (drive.IsReady && drive.AvailableFreeSpace < needed)
            {
                throw new IOException("Not enough free disk space on " + drive.Name + ": about "
                    + (needed / 1000000) + " MB is needed.");
            }

            var tmp = Path.Combine(Root, "setup-download");
            Directory.CreateDirectory(tmp);

            if (NeedWhisper)
            {
                var zip = Path.Combine(tmp, "whisper.zip");
                Download(WhisperUrl, zip, 0, WhisperBytes, "speech engine (whisper.cpp)");
                Report("Unpacking speech engine...", 0, true);
                ExtractFolderOf(zip, "whisper-cli.exe", Path.GetDirectoryName(WhisperExe));
                File.Delete(zip);
            }
            if (NeedFfmpeg)
            {
                var zip = Path.Combine(tmp, "ffmpeg.zip");
                Download(FfmpegUrl, zip, 0, FfmpegBytes, "audio tools (ffmpeg)");
                Report("Unpacking audio tools...", 0, true);
                ExtractSingle(zip, "ffmpeg.exe", FfmpegExe);
                File.Delete(zip);
            }
            if (NeedVad) Download(VadUrl, VadPath, VadBytes, VadBytes, "speech detector");
            if (NeedModel) Download(ModelUrl, ModelPath, ModelBytes, ModelBytes, "Large v3 Turbo speech model");

            try { Directory.Delete(tmp, true); } catch (IOException) { }
            report("Speech engine and Large v3 Turbo model installed.", 100);
        }

        // Downloads to "<dest>.part", resuming a previous partial download when the
        // server allows it, then renames. exactBytes > 0 checks the finished size.
        void Download(string url, string dest, long exactBytes, long estimate, string label)
        {
            var part = dest + ".part";
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            long have = File.Exists(part) ? new FileInfo(part).Length : 0;
            if (exactBytes > 0 && have > exactBytes) { File.Delete(part); have = 0; }
            if (exactBytes <= 0 && have > 0) { File.Delete(part); have = 0; } // zips change between releases

            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    DownloadOnce(url, part, ref have, estimate, label);
                    break;
                }
                catch (WebException e)
                {
                    if (cancelled) throw new OperationCanceledException();
                    if (attempt >= 3) throw new IOException("Couldn't download the " + label + ": " + e.Message, e);
                    Report("Connection problem, retrying the " + label + "...", have, true);
                    Thread.Sleep(2000 * attempt);
                    have = File.Exists(part) ? new FileInfo(part).Length : 0;
                }
                catch (IOException e)
                {
                    if (cancelled || attempt >= 3) throw;
                    Report("Connection problem, retrying the " + label + "... (" + e.Message + ")", have, true);
                    Thread.Sleep(2000 * attempt);
                    have = File.Exists(part) ? new FileInfo(part).Length : 0;
                }
            }

            long size = new FileInfo(part).Length;
            if (exactBytes > 0 && size != exactBytes)
            {
                File.Delete(part);
                throw new IOException("The " + label + " download was incomplete (" + size + " of " + exactBytes + " bytes). Try again.");
            }
            if (File.Exists(dest)) File.Delete(dest);
            File.Move(part, dest);
            done += estimate;
        }

        void DownloadOnce(string url, string part, ref long have, long estimate, string label)
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "BetterCaptionsSetup/1.0";
            request.AllowAutoRedirect = true;
            request.Timeout = 30000;
            request.ReadWriteTimeout = 60000;
            if (have > 0) request.AddRange(have);

            using (var response = (HttpWebResponse)request.GetResponse())
            {
                bool resumed = have > 0 && response.StatusCode == HttpStatusCode.PartialContent;
                if (!resumed) have = 0;
                long length = response.ContentLength > 0 ? response.ContentLength + have : 0;
                long scale = length > 0 ? length : estimate;

                using (var input = response.GetResponseStream())
                using (var output = new FileStream(part, resumed ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                {
                    var buffer = new byte[1 << 16];
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (cancelled) throw new OperationCanceledException();
                        output.Write(buffer, 0, read);
                        have += read;
                        long stepDone = scale > 0 ? Math.Min(estimate, have * estimate / scale) : 0;
                        Report("Downloading " + label + ": " + (have / 1000000) + " of "
                            + (Math.Max(scale, have) / 1000000) + " MB", stepDone, false);
                    }
                }
                if (length > 0 && have < length) throw new IOException("the connection closed early");
            }
        }

        // Extracts the files sitting next to `fileName` in the zip (whisper-cli.exe
        // and its DLLs) into `destDir`.
        static void ExtractFolderOf(string zipPath, string fileName, string destDir)
        {
            using (var zip = ZipFile.OpenRead(zipPath))
            {
                var anchor = zip.Entries.FirstOrDefault(e => string.Equals(e.Name, fileName, StringComparison.OrdinalIgnoreCase));
                if (anchor == null) throw new IOException(fileName + " was not found in the speech engine download.");
                var folder = anchor.FullName.Substring(0, anchor.FullName.Length - anchor.Name.Length);
                Directory.CreateDirectory(destDir);
                foreach (var entry in zip.Entries)
                {
                    if (entry.Name.Length == 0 || !entry.FullName.StartsWith(folder, StringComparison.Ordinal)) continue;
                    var rest = entry.FullName.Substring(folder.Length);
                    if (rest.Contains("/") || rest.Contains("\\") || rest.Contains("..")) continue;
                    entry.ExtractToFile(Path.Combine(destDir, rest), true);
                }
            }
        }

        static void ExtractSingle(string zipPath, string fileName, string dest)
        {
            using (var zip = ZipFile.OpenRead(zipPath))
            {
                var entry = zip.Entries.FirstOrDefault(e => string.Equals(e.Name, fileName, StringComparison.OrdinalIgnoreCase));
                if (entry == null) throw new IOException(fileName + " was not found in the audio tools download.");
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                entry.ExtractToFile(dest, true);
            }
        }
    }

    class InstallerForm : Form
    {
        readonly ExtensionInstaller installer;
        readonly Label statusLabel;
        readonly Button installButton;
        readonly Button uninstallButton;
        readonly Button openButton;
        readonly Button cancelButton;
        readonly ProgressBar progress;
        readonly EngineDownloader engine;
        bool downloading;

        static readonly Color Accent = Color.FromArgb(124, 92, 255);

        public InstallerForm(ExtensionInstaller installer, bool startWithUninstall)
        {
            this.installer = installer;
            engine = new EngineDownloader(installer.Options.EngineDir);

            Text = "Better Captions Setup";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(480, 330);
            Font = new Font("Segoe UI", 9.5f);
            BackColor = Color.White;
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

            var header = new Panel { Dock = DockStyle.Top, Height = 72, BackColor = Accent };
            header.Controls.Add(new Label
            {
                Text = "Better Captions",
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 16f),
                AutoSize = true,
                Location = new Point(20, 10),
            });
            header.Controls.Add(new Label
            {
                Text = "Offline, stylised captions for Adobe Premiere Pro",
                ForeColor = Color.FromArgb(230, 225, 255),
                AutoSize = true,
                Location = new Point(22, 44),
            });
            Controls.Add(header);

            Controls.Add(new Label
            {
                Text = "Installs the Better Captions panel, then downloads the offline speech engine and the Large v3 Turbo model (about 700 MB, one time only).",
                Location = new Point(20, 88),
                Size = new Size(440, 44),
            });

            statusLabel = new Label
            {
                Location = new Point(20, 140),
                Size = new Size(440, 86),
                ForeColor = Color.FromArgb(60, 60, 60),
            };
            Controls.Add(statusLabel);

            progress = new ProgressBar
            {
                Location = new Point(20, 236),
                Size = new Size(440, 14),
                Minimum = 0,
                Maximum = 100,
                Visible = false,
            };
            Controls.Add(progress);

            installButton = MakeButton("Install", 20, true);
            installButton.Click += delegate { RunInstall(); };
            uninstallButton = MakeButton("Uninstall", 150, false);
            uninstallButton.Click += delegate { RunUninstall(); };
            openButton = MakeButton("Open Premiere Pro", 280, false);
            openButton.Width = 180;
            openButton.Click += delegate { OpenPremiere(); };
            cancelButton = MakeButton("Cancel", 150, false);
            cancelButton.Visible = false;
            cancelButton.Click += delegate { CancelDownload(); };
            Controls.AddRange(new Control[] { installButton, uninstallButton, openButton, cancelButton });
            FormClosing += OnFormClosing;
            AcceptButton = installButton;

            RefreshState(null);
            if (startWithUninstall) Shown += delegate { RunUninstall(); };
        }

        static Button MakeButton(string text, int x, bool primary)
        {
            var b = new Button
            {
                Text = text,
                Location = new Point(x, 275),
                Size = new Size(120, 34),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand,
            };
            if (primary)
            {
                b.BackColor = Accent;
                b.ForeColor = Color.White;
                b.FlatAppearance.BorderSize = 0;
            }
            return b;
        }

        void RefreshState(string message)
        {
            var installed = installer.InstalledVersion;
            var packaged = installer.PackagedVersion;
            installButton.Text = installed == null ? "Install" : "Reinstall";
            uninstallButton.Enabled = installed != null;
            openButton.Enabled = installed != null && ExtensionInstaller.FindPremiere() != null;

            var lines = new List<string>();
            if (message != null) lines.Add(message);
            lines.Add(installed == null
                ? "Not installed yet. This setup contains version " + packaged + "."
                : "Installed: version " + installed + " (this setup contains " + packaged + ").");
            if (engine.IsInstalled)
                lines.Add("Speech engine: installed, with the Large v3 Turbo model.");
            else if (installer.Options.NoEngine)
                lines.Add("Speech engine: not downloaded (/noengine). The panel's setup button can download it.");
            else
                lines.Add("Speech engine: downloaded when you click " + installButton.Text
                    + " (about " + Math.Max(1, engine.RemainingBytes / 1000000) + " MB).");
            statusLabel.Text = string.Join(Environment.NewLine + Environment.NewLine, lines);
        }

        bool WaitForPremiereToClose()
        {
            while (ExtensionInstaller.IsPremiereRunning())
            {
                var answer = MessageBox.Show(this,
                    "Premiere Pro is open. Save your work, close Premiere, then click Retry.",
                    "Close Premiere Pro", MessageBoxButtons.RetryCancel, MessageBoxIcon.Information);
                if (answer != DialogResult.Retry) return false;
            }
            return true;
        }

        void RunInstall()
        {
            if (!WaitForPremiereToClose()) return;
            try
            {
                UseWaitCursor = true;
                var changed = installer.Install();
                var note = changed.Count > 0
                    ? " Turned on unsigned-extension loading for " + string.Join(", ", changed) + "."
                    : "";
                var done = "Installed. Open Premiere Pro, then go to Window > Extensions > Better Captions." + note;
                if (!installer.Options.NoEngine && !engine.IsInstalled) StartEngineDownload(done);
                else RefreshState(done);
            }
            catch (Exception e)
            {
                MessageBox.Show(this, "Install failed: " + e.Message, "Better Captions", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                UseWaitCursor = false;
            }
        }

        void StartEngineDownload(string installedMessage)
        {
            downloading = true;
            installButton.Enabled = false;
            uninstallButton.Visible = false;
            openButton.Enabled = false;
            cancelButton.Visible = true;
            cancelButton.Enabled = true;
            progress.Value = 0;
            progress.Style = ProgressBarStyle.Continuous;
            progress.Visible = true;
            statusLabel.Text = "Panel installed. Downloading the speech engine...";

            var worker = new Thread(delegate()
            {
                string result;
                bool ok = false;
                try
                {
                    engine.Run(delegate(string message, int percent) { OnUi(delegate { ShowProgress(message, percent); }); });
                    ok = true;
                    result = installedMessage + Environment.NewLine + Environment.NewLine
                        + "The speech engine and Large v3 Turbo model are ready. Captions work offline from now on.";
                }
                catch (OperationCanceledException)
                {
                    result = installedMessage + Environment.NewLine + Environment.NewLine
                        + "Speech engine download stopped. Click Reinstall to continue it (it picks up where it stopped), or use Set up offline engine in the panel.";
                }
                catch (Exception e)
                {
                    result = installedMessage + Environment.NewLine + Environment.NewLine
                        + "The speech engine couldn't be downloaded: " + e.Message
                        + " Check your internet connection and click Reinstall, or use Set up offline engine in the panel.";
                }
                OnUi(delegate { FinishDownload(result, ok); });
            });
            worker.IsBackground = true;
            worker.Start();
        }

        void OnUi(MethodInvoker action)
        {
            try
            {
                if (IsHandleCreated && !IsDisposed) BeginInvoke(action);
            }
            catch (InvalidOperationException) { }
        }

        void ShowProgress(string message, int percent)
        {
            if (!downloading) return;
            if (percent < 0) progress.Style = ProgressBarStyle.Marquee;
            else
            {
                progress.Style = ProgressBarStyle.Continuous;
                progress.Value = Math.Max(0, Math.Min(100, percent));
            }
            statusLabel.Text = "Panel installed. Setting up the offline speech engine"
                + (percent >= 0 ? " (" + percent + "%)" : "") + "..." + Environment.NewLine + Environment.NewLine + message;
        }

        void FinishDownload(string message, bool ok)
        {
            downloading = false;
            progress.Visible = false;
            cancelButton.Visible = false;
            uninstallButton.Visible = true;
            installButton.Enabled = true;
            RefreshState(null);
            statusLabel.Text = message;
            if (!ok) System.Media.SystemSounds.Exclamation.Play();
        }

        void CancelDownload()
        {
            cancelButton.Enabled = false;
            statusLabel.Text = "Stopping the download...";
            engine.Cancel();
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!downloading) return;
            var answer = MessageBox.Show(this,
                "The speech engine is still downloading. Stop and close?" + Environment.NewLine + Environment.NewLine +
                "The panel is already installed. Run setup again later to finish the download; it continues where it stopped.",
                "Better Captions Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer == DialogResult.Yes) engine.Cancel();
            else e.Cancel = true;
        }

        void RunUninstall()
        {
            if (installer.InstalledVersion == null)
            {
                RefreshState("Better Captions isn't installed.");
                return;
            }
            if (!WaitForPremiereToClose()) return;

            var removeData = false;
            if (Directory.Exists(ExtensionInstaller.EngineDataDir))
            {
                var answer = MessageBox.Show(this,
                    "Also delete the downloaded speech engine and saved captions?" + Environment.NewLine + Environment.NewLine +
                    "Choose No to keep them, so you won't need to download them again if you reinstall.",
                    "Uninstall Better Captions", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (answer == DialogResult.Cancel) return;
                removeData = answer == DialogResult.Yes;
            }

            try
            {
                installer.Uninstall(removeData);
                RefreshState("Better Captions was uninstalled.");
            }
            catch (Exception e)
            {
                MessageBox.Show(this, "Uninstall failed: " + e.Message, "Better Captions", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        void OpenPremiere()
        {
            var exe = ExtensionInstaller.FindPremiere();
            if (exe == null)
            {
                MessageBox.Show(this, "Premiere Pro wasn't found in Program Files\\Adobe.", "Better Captions");
                return;
            }
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            statusLabel.Text = "Starting Premiere Pro... When it opens, go to Window > Extensions > Better Captions.";
        }
    }
}
