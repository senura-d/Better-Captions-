// Better Captions installer: a modern, sleek Windows installer that installs
// the CEP extension (packed inside this .exe as Extension.zip) into the current
// user's Adobe CEP extensions folder. No admin rights needed.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4.8),
// so it runs standalone with zero prerequisites on Windows 10 & 11.
//
// Command line:
//   BetterCaptionsSetup.exe                 show the installer window
//   BetterCaptionsSetup.exe /silent         install without a window
//   BetterCaptionsSetup.exe /uninstall      uninstall (add /silent for no window)
//   BetterCaptionsSetup.exe /noengine       install the panel only, without downloading
//                                           the speech engine and Large v3 Turbo model
// Testing: /extdir:"path", /noregistry, /ignorepremiere, /enginedir:"path", /screenshot:"path"

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
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
                    Console.Error.WriteLine("The panel is installed, but the speech engine download failed: " + e.Message);
                    return 2;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (options.ScreenshotPath != null)
            {
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
            : base("Premiere Pro is currently open. Save your project, close Premiere Pro, then try again.") { }
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
                try
                {
                    using (var zip = new ZipArchive(OpenPayload(), ZipArchiveMode.Read))
                    {
                        var entry = zip.Entries.FirstOrDefault(e => e.FullName.Replace('\\', '/') == "CSXS/manifest.xml");
                        if (entry == null) return null;
                        using (var reader = new StreamReader(entry.Open())) return ReadVersion(reader.ReadToEnd());
                    }
                }
                catch { return "1.0.0"; }
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
                key.SetValue("DisplayVersion", PackagedVersion ?? "1.0.0");
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
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);

            var self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            if (self.StartsWith(Path.GetFullPath(SetupCopyDir), StringComparison.OrdinalIgnoreCase))
            {
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
            return candidates.OrderByDescending(p => p, StringComparer.OrdinalIgnoreCase).FirstOrDefault();
        }
    }

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
            if (!force && (now - lastReport).TotalMilliseconds < 150) return;
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
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;
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
            if (NeedVad) Download(VadUrl, VadPath, VadBytes, VadBytes, "Silero voice activity detector");
            if (NeedModel) Download(ModelUrl, ModelPath, ModelBytes, ModelBytes, "Whisper Large v3 Turbo model");

            try { Directory.Delete(tmp, true); } catch (IOException) { }
            report("Speech engine and Large v3 Turbo model ready.", 100);
        }

        void Download(string url, string dest, long exactBytes, long estimate, string label)
        {
            var part = dest + ".part";
            Directory.CreateDirectory(Path.GetDirectoryName(dest));

            long have = File.Exists(part) ? new FileInfo(part).Length : 0;
            if (exactBytes > 0 && have > exactBytes) { File.Delete(part); have = 0; }
            if (exactBytes <= 0 && have > 0) { File.Delete(part); have = 0; }

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
                    if (attempt >= 3) throw new IOException("Couldn't download " + label + ": " + e.Message, e);
                    Report("Connection issue, retrying " + label + "...", have, true);
                    Thread.Sleep(2000 * attempt);
                    have = File.Exists(part) ? new FileInfo(part).Length : 0;
                }
                catch (IOException e)
                {
                    if (cancelled || attempt >= 3) throw;
                    Report("Connection issue, retrying " + label + "... (" + e.Message + ")", have, true);
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
                        Report("Downloading " + label + ": " + (have / 1000000) + " / "
                            + (Math.Max(scale, have) / 1000000) + " MB", stepDone, false);
                    }
                }
                if (length > 0 && have < length) throw new IOException("Connection closed prematurely.");
            }
        }

        static void ExtractFolderOf(string zipPath, string fileName, string destDir)
        {
            using (var zip = ZipFile.OpenRead(zipPath))
            {
                var anchor = zip.Entries.FirstOrDefault(e => string.Equals(e.Name, fileName, StringComparison.OrdinalIgnoreCase));
                if (anchor == null) throw new IOException(fileName + " was not found in the speech engine archive.");
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
                if (entry == null) throw new IOException(fileName + " was not found in the archive.");
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                entry.ExtractToFile(dest, true);
            }
        }
    }

    #region Custom Modern UI Controls

    public static class GraphicsUtils
    {
        public static GraphicsPath CreateRoundedRectangle(Rectangle bounds, int radius)
        {
            var path = new GraphicsPath();
            if (radius <= 0)
            {
                path.AddRectangle(bounds);
                return path;
            }
            int d = radius * 2;
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    public class ModernButton : Button
    {
        public bool IsPrimary { get; set; }
        public bool IsDestructive { get; set; }
        public int CornerRadius { get; set; }

        bool isHovered;
        bool isPressed;

        public ModernButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            CornerRadius = 8;
            Cursor = Cursors.Hand;
            Font = new Font("Segoe UI Semibold", 9.5f);
            Size = new Size(130, 38);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            isHovered = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            isHovered = false;
            isPressed = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs mevent)
        {
            isPressed = true;
            Invalidate();
            base.OnMouseDown(mevent);
        }

        protected override void OnMouseUp(MouseEventArgs mevent)
        {
            isPressed = false;
            Invalidate();
            base.OnMouseUp(mevent);
        }

        protected override void OnPaint(PaintEventArgs pevent)
        {
            var g = pevent.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var path = GraphicsUtils.CreateRoundedRectangle(rect, CornerRadius))
            {
                Color bgTop, bgBottom, borderColor, textColor;

                if (!Enabled)
                {
                    bgTop = bgBottom = Color.FromArgb(32, 34, 44);
                    borderColor = Color.FromArgb(48, 51, 65);
                    textColor = Color.FromArgb(100, 105, 125);
                }
                else if (IsPrimary)
                {
                    if (isPressed)
                    {
                        bgTop = Color.FromArgb(109, 40, 217);
                        bgBottom = Color.FromArgb(91, 33, 182);
                    }
                    else if (isHovered)
                    {
                        bgTop = Color.FromArgb(147, 83, 255);
                        bgBottom = Color.FromArgb(124, 58, 237);
                    }
                    else
                    {
                        bgTop = Color.FromArgb(139, 92, 246);
                        bgBottom = Color.FromArgb(109, 40, 217);
                    }
                    borderColor = Color.FromArgb(167, 139, 250);
                    textColor = Color.White;
                }
                else if (IsDestructive)
                {
                    if (isPressed)
                    {
                        bgTop = bgBottom = Color.FromArgb(153, 27, 27);
                    }
                    else if (isHovered)
                    {
                        bgTop = bgBottom = Color.FromArgb(69, 26, 33);
                    }
                    else
                    {
                        bgTop = bgBottom = Color.FromArgb(24, 25, 33);
                    }
                    borderColor = isHovered ? Color.FromArgb(239, 68, 68) : Color.FromArgb(60, 40, 50);
                    textColor = isHovered ? Color.FromArgb(248, 113, 113) : Color.FromArgb(180, 140, 150);
                }
                else
                {
                    // Standard secondary dark button
                    if (isPressed)
                    {
                        bgTop = bgBottom = Color.FromArgb(45, 48, 62);
                    }
                    else if (isHovered)
                    {
                        bgTop = bgBottom = Color.FromArgb(40, 43, 56);
                    }
                    else
                    {
                        bgTop = bgBottom = Color.FromArgb(28, 30, 40);
                    }
                    borderColor = isHovered ? Color.FromArgb(139, 92, 246) : Color.FromArgb(50, 54, 70);
                    textColor = isHovered ? Color.White : Color.FromArgb(215, 220, 235);
                }

                using (var brush = new LinearGradientBrush(rect, bgTop, bgBottom, LinearGradientMode.Vertical))
                {
                    g.FillPath(brush, path);
                }
                using (var pen = new Pen(borderColor, 1f))
                {
                    g.DrawPath(pen, path);
                }

                // Text
                var sf = new StringFormat
                {
                    Alignment = StringAlignment.Center,
                    LineAlignment = StringAlignment.Center
                };
                using (var textBrush = new SolidBrush(textColor))
                {
                    g.DrawString(Text, Font, textBrush, rect, sf);
                }
            }
        }
    }

    public class ModernProgressBar : Control
    {
        int val;
        public int Value
        {
            get { return val; }
            set
            {
                val = Math.Max(0, Math.Min(100, value));
                Invalidate();
            }
        }

        public bool IsMarquee { get; set; }
        int marqueeOffset = 0;
        System.Windows.Forms.Timer marqueeTimer;

        public ModernProgressBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Height = 12;
            DoubleBuffered = true;
        }

        public void StartMarquee()
        {
            IsMarquee = true;
            if (marqueeTimer == null)
            {
                marqueeTimer = new System.Windows.Forms.Timer { Interval = 25 };
                marqueeTimer.Tick += delegate
                {
                    marqueeOffset = (marqueeOffset + 4) % (Width + 80);
                    Invalidate();
                };
            }
            marqueeTimer.Start();
        }

        public void StopMarquee()
        {
            IsMarquee = false;
            if (marqueeTimer != null) marqueeTimer.Stop();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            var trackRect = new Rectangle(0, 0, Width - 1, Height - 1);
            int radius = Height / 2;

            // Track background
            using (var path = GraphicsUtils.CreateRoundedRectangle(trackRect, radius))
            {
                using (var brush = new SolidBrush(Color.FromArgb(28, 30, 42)))
                {
                    g.FillPath(brush, path);
                }
                using (var pen = new Pen(Color.FromArgb(45, 48, 64), 1f))
                {
                    g.DrawPath(pen, path);
                }
            }

            // Fill
            if (IsMarquee)
            {
                int barWidth = Math.Max(40, Width / 3);
                int x = marqueeOffset - barWidth;
                var fillRect = new Rectangle(Math.Max(0, x), 1, barWidth, Height - 2);
                if (fillRect.Width > 0 && fillRect.Right <= Width)
                {
                    using (var path = GraphicsUtils.CreateRoundedRectangle(fillRect, radius - 1))
                    using (var brush = new LinearGradientBrush(fillRect, Color.FromArgb(124, 92, 255), Color.FromArgb(236, 72, 153), LinearGradientMode.Horizontal))
                    {
                        g.FillPath(brush, path);
                    }
                }
            }
            else if (Value > 0)
            {
                int fillWidth = (int)((Width - 2) * (Value / 100.0));
                if (fillWidth > radius * 2)
                {
                    var fillRect = new Rectangle(1, 1, fillWidth, Height - 2);
                    using (var path = GraphicsUtils.CreateRoundedRectangle(fillRect, radius - 1))
                    using (var brush = new LinearGradientBrush(fillRect, Color.FromArgb(124, 92, 255), Color.FromArgb(168, 85, 247), LinearGradientMode.Horizontal))
                    {
                        g.FillPath(brush, path);
                    }
                }
                else if (fillWidth > 0)
                {
                    var fillRect = new Rectangle(1, 1, fillWidth, Height - 2);
                    using (var brush = new SolidBrush(Color.FromArgb(124, 92, 255)))
                    {
                        g.FillRectangle(brush, fillRect);
                    }
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && marqueeTimer != null) marqueeTimer.Dispose();
            base.Dispose(disposing);
        }
    }

    #endregion

    class InstallerForm : Form
    {
        readonly ExtensionInstaller installer;
        readonly EngineDownloader engine;

        readonly Panel headerPanel;
        readonly Panel cardPanel;
        readonly Panel bottomBar;

        readonly Label titleLabel;
        readonly Label subtitleLabel;
        readonly Label versionBadge;

        readonly Label premiereStatusIcon;
        readonly Label premiereStatusText;
        readonly Label extensionStatusIcon;
        readonly Label extensionStatusText;
        readonly Label engineStatusIcon;
        readonly Label engineStatusText;
        readonly Label pathInfoLabel;

        readonly Label progressStatusLabel;
        readonly Label progressPercentLabel;
        readonly ModernProgressBar modernProgress;

        readonly ModernButton installButton;
        readonly ModernButton uninstallButton;
        readonly ModernButton openButton;
        readonly ModernButton cancelButton;

        bool downloading;

        static readonly Color BgDark = Color.FromArgb(18, 19, 26);
        static readonly Color CardBg = Color.FromArgb(26, 28, 38);
        static readonly Color CardBorder = Color.FromArgb(44, 47, 63);
        static readonly Color AccentPurple = Color.FromArgb(124, 92, 255);
        static readonly Color TextPrimary = Color.FromArgb(248, 250, 252);
        static readonly Color TextMuted = Color.FromArgb(148, 163, 184);
        static readonly Color GreenSuccess = Color.FromArgb(52, 211, 153);
        static readonly Color AmberWarning = Color.FromArgb(251, 191, 36);

        public InstallerForm(ExtensionInstaller installer, bool startWithUninstall)
        {
            this.installer = installer;
            engine = new EngineDownloader(installer.Options.EngineDir);

            // Window styling
            Text = "Better Captions Setup";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(580, 480);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            BackColor = BgDark;
            ForeColor = TextPrimary;
            DoubleBuffered = true;

            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

            // 1. HEADER BANNER
            headerPanel = new Panel
            {
                Dock = DockStyle.Top,
                Height = 100,
                BackColor = Color.FromArgb(22, 23, 33)
            };
            headerPanel.Paint += delegate(object s, PaintEventArgs pe)
            {
                var g = pe.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;

                // Subtle gradient glow in top right
                using (var bgBrush = new LinearGradientBrush(headerPanel.ClientRectangle,
                    Color.FromArgb(29, 28, 44), Color.FromArgb(20, 21, 30), LinearGradientMode.Vertical))
                {
                    g.FillRectangle(bgBrush, headerPanel.ClientRectangle);
                }

                // Bottom divider line
                using (var linePen = new Pen(Color.FromArgb(38, 41, 56), 1f))
                {
                    g.DrawLine(linePen, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
                }

                // App Icon / Logo Box (Squircle)
                var iconRect = new Rectangle(24, 18, 56, 56);
                using (var path = GraphicsUtils.CreateRoundedRectangle(iconRect, 14))
                {
                    using (var iconBrush = new LinearGradientBrush(iconRect, Color.FromArgb(139, 92, 246), Color.FromArgb(99, 102, 241), LinearGradientMode.ForwardDiagonal))
                    {
                        g.FillPath(iconBrush, path);
                    }
                    using (var pen = new Pen(Color.FromArgb(167, 139, 250), 1f))
                    {
                        g.DrawPath(pen, path);
                    }
                }

                // Subtitle / Caption Graphic bars inside squircle
                using (var whiteBrush = new SolidBrush(Color.White))
                {
                    g.FillRectangle(whiteBrush, 36, 36, 32, 6);
                    g.FillRectangle(whiteBrush, 42, 48, 20, 6);
                }
            };

            titleLabel = new Label
            {
                Text = "Better Captions",
                ForeColor = TextPrimary,
                Font = new Font("Segoe UI Semibold", 17f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(94, 20),
                BackColor = Color.Transparent,
                UseMnemonic = false
            };
            versionBadge = new Label
            {
                Text = "v" + (installer.PackagedVersion ?? "1.0.0"),
                ForeColor = Color.FromArgb(196, 181, 253),
                BackColor = Color.FromArgb(46, 36, 78),
                Font = new Font("Segoe UI Semibold", 8.5f),
                AutoSize = true,
                Padding = new Padding(7, 3, 7, 3),
                Location = new Point(275, 25),
                UseMnemonic = false
            };
            subtitleLabel = new Label
            {
                Text = "Free & Offline AI Captions • Kinetic Typography • Beat Markers",
                ForeColor = TextMuted,
                Font = new Font("Segoe UI", 9f),
                AutoSize = true,
                Location = new Point(96, 54),
                BackColor = Color.Transparent,
                UseMnemonic = false
            };

            headerPanel.Controls.Add(titleLabel);
            headerPanel.Controls.Add(versionBadge);
            headerPanel.Controls.Add(subtitleLabel);
            Controls.Add(headerPanel);

            // 2. FEATURE PILLS (Below Header)
            var pillsPanel = new FlowLayoutPanel
            {
                Location = new Point(24, 112),
                Size = new Size(532, 28),
                BackColor = Color.Transparent,
                WrapContents = false
            };
            pillsPanel.Controls.Add(CreatePill("⚡ 100% Offline"));
            pillsPanel.Controls.Add(CreatePill("🎙️ Whisper Large v3"));
            pillsPanel.Controls.Add(CreatePill("🎬 ProRes 4444 Overlay"));
            pillsPanel.Controls.Add(CreatePill("🎵 Beat Markers"));
            Controls.Add(pillsPanel);

            // 3. STATUS & ENVIRONMENT CARD
            cardPanel = new Panel
            {
                Location = new Point(24, 150),
                Size = new Size(532, 172),
                BackColor = CardBg
            };
            cardPanel.Paint += delegate(object s, PaintEventArgs pe)
            {
                var g = pe.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                var rect = new Rectangle(0, 0, cardPanel.Width - 1, cardPanel.Height - 1);
                using (var path = GraphicsUtils.CreateRoundedRectangle(rect, 10))
                {
                    using (var brush = new SolidBrush(CardBg)) g.FillPath(brush, path);
                    using (var pen = new Pen(CardBorder, 1f)) g.DrawPath(pen, path);
                }
            };

            // Card Items
            premiereStatusIcon = new Label { Location = new Point(20, 16), Size = new Size(18, 18), Text = "✓", Font = new Font("Segoe UI", 10f), ForeColor = GreenSuccess, UseMnemonic = false };
            premiereStatusText = new Label { Location = new Point(44, 16), Size = new Size(465, 20), ForeColor = TextPrimary, Font = new Font("Segoe UI Semibold", 9.25f), UseMnemonic = false };

            extensionStatusIcon = new Label { Location = new Point(20, 48), Size = new Size(18, 18), Text = "●", Font = new Font("Segoe UI", 10f), ForeColor = GreenSuccess, UseMnemonic = false };
            extensionStatusText = new Label { Location = new Point(44, 48), Size = new Size(465, 20), ForeColor = TextPrimary, Font = new Font("Segoe UI Semibold", 9.25f), UseMnemonic = false };

            engineStatusIcon = new Label { Location = new Point(20, 80), Size = new Size(18, 18), Text = "●", Font = new Font("Segoe UI", 10f), ForeColor = AmberWarning, UseMnemonic = false };
            engineStatusText = new Label { Location = new Point(44, 80), Size = new Size(465, 42), ForeColor = TextMuted, Font = new Font("Segoe UI", 9f), UseMnemonic = false };

            pathInfoLabel = new Label
            {
                Location = new Point(20, 134),
                Size = new Size(490, 24),
                ForeColor = Color.FromArgb(100, 116, 139),
                Font = new Font("Segoe UI", 8.5f),
                Text = "Target: " + installer.TargetDir,
                UseMnemonic = false
            };

            cardPanel.Controls.Add(premiereStatusIcon);
            cardPanel.Controls.Add(premiereStatusText);
            cardPanel.Controls.Add(extensionStatusIcon);
            cardPanel.Controls.Add(extensionStatusText);
            cardPanel.Controls.Add(engineStatusIcon);
            cardPanel.Controls.Add(engineStatusText);
            cardPanel.Controls.Add(pathInfoLabel);
            Controls.Add(cardPanel);

            // 4. PROGRESS BAR & STATUS AREA
            progressStatusLabel = new Label
            {
                Location = new Point(24, 332),
                Size = new Size(450, 20),
                ForeColor = TextPrimary,
                Font = new Font("Segoe UI Semibold", 9f),
                Text = "Ready to install",
                UseMnemonic = false
            };
            progressPercentLabel = new Label
            {
                Location = new Point(480, 332),
                Size = new Size(76, 20),
                ForeColor = AccentPurple,
                Font = new Font("Segoe UI Semibold", 9f),
                TextAlign = ContentAlignment.TopRight,
                Text = "",
                UseMnemonic = false
            };
            modernProgress = new ModernProgressBar
            {
                Location = new Point(24, 356),
                Size = new Size(532, 10),
                Visible = false
            };

            Controls.Add(progressStatusLabel);
            Controls.Add(progressPercentLabel);
            Controls.Add(modernProgress);

            // 5. BOTTOM BAR & ACTION BUTTONS
            bottomBar = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 80,
                BackColor = Color.FromArgb(16, 17, 24)
            };
            bottomBar.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (var pen = new Pen(Color.FromArgb(32, 35, 48), 1f))
                {
                    pe.Graphics.DrawLine(pen, 0, 0, bottomBar.Width, 0);
                }
            };

            uninstallButton = new ModernButton
            {
                Text = "Uninstall",
                Location = new Point(24, 20),
                Size = new Size(95, 38),
                IsDestructive = true
            };
            uninstallButton.Click += delegate { RunUninstall(); };

            openButton = new ModernButton
            {
                Text = "Open Premiere",
                Location = new Point(255, 20),
                Size = new Size(135, 38),
                IsPrimary = false
            };
            openButton.Click += delegate { OpenPremiere(); };

            installButton = new ModernButton
            {
                Text = "Install Extension",
                Location = new Point(400, 20),
                Size = new Size(156, 38),
                IsPrimary = true
            };
            installButton.Click += delegate { RunInstall(); };

            cancelButton = new ModernButton
            {
                Text = "Cancel",
                Location = new Point(426, 20),
                Size = new Size(130, 38),
                IsDestructive = true,
                Visible = false
            };
            cancelButton.Click += delegate { CancelDownload(); };

            bottomBar.Controls.Add(uninstallButton);
            bottomBar.Controls.Add(openButton);
            bottomBar.Controls.Add(installButton);
            bottomBar.Controls.Add(cancelButton);
            Controls.Add(bottomBar);

            FormClosing += OnFormClosing;
            AcceptButton = installButton;

            RefreshState(null);
            if (startWithUninstall) Shown += delegate { RunUninstall(); };
        }

        static Label CreatePill(string text)
        {
            var l = new Label
            {
                Text = text,
                AutoSize = true,
                Font = new Font("Segoe UI Semibold", 8.25f, FontStyle.Regular),
                ForeColor = Color.FromArgb(203, 213, 225),
                BackColor = Color.FromArgb(30, 32, 45),
                Padding = new Padding(8, 4, 8, 4),
                Margin = new Padding(0, 0, 8, 0),
                UseMnemonic = false
            };
            l.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (var pen = new Pen(Color.FromArgb(52, 56, 76), 1f))
                {
                    pe.Graphics.DrawRectangle(pen, 0, 0, l.Width - 1, l.Height - 1);
                }
            };
            return l;
        }

        void RefreshState(string message)
        {
            var premiereExe = ExtensionInstaller.FindPremiere();
            if (premiereExe != null)
            {
                premiereStatusIcon.Text = "✓";
                premiereStatusIcon.ForeColor = GreenSuccess;
                premiereStatusText.Text = "Adobe Premiere Pro Detected";
            }
            else
            {
                premiereStatusIcon.Text = "!";
                premiereStatusIcon.ForeColor = AmberWarning;
                premiereStatusText.Text = "Premiere Pro: Not found in standard Program Files path";
            }

            var installed = installer.InstalledVersion;
            var packaged = installer.PackagedVersion;

            if (installed != null)
            {
                extensionStatusIcon.Text = "✓";
                extensionStatusIcon.ForeColor = GreenSuccess;
                extensionStatusText.Text = "Panel Extension: Installed (v" + installed + ")";
                installButton.Text = "Reinstall";
            }
            else
            {
                extensionStatusIcon.Text = "●";
                extensionStatusIcon.ForeColor = Color.FromArgb(148, 163, 184);
                extensionStatusText.Text = "Panel Extension: Not Installed";
                installButton.Text = "Install Extension";
            }

            uninstallButton.Enabled = installed != null;
            openButton.Enabled = installed != null && premiereExe != null;

            if (engine.IsInstalled)
            {
                engineStatusIcon.Text = "✓";
                engineStatusIcon.ForeColor = GreenSuccess;
                engineStatusText.Text = "Speech Engine: Installed & Ready (Whisper Large v3 Turbo, 100% offline).";
            }
            else if (installer.Options.NoEngine)
            {
                engineStatusIcon.Text = "!";
                engineStatusIcon.ForeColor = AmberWarning;
                engineStatusText.Text = "Speech Engine: Skipped via /noengine flag.";
            }
            else
            {
                long remMb = Math.Max(1, engine.RemainingBytes / 1000000);
                engineStatusIcon.Text = "↓";
                engineStatusIcon.ForeColor = AccentPurple;
                engineStatusText.Text = "Speech Engine: Downloads on setup (~" + remMb + " MB, Whisper Large v3 Turbo).";
            }

            if (message != null)
            {
                progressStatusLabel.Text = message;
                progressPercentLabel.Text = "";
            }
            else
            {
                progressStatusLabel.Text = installed == null
                    ? "Click 'Install Extension' to begin setup."
                    : "Extension is ready. Open Premiere Pro → Window → Extensions → Better Captions.";
            }
        }

        bool WaitForPremiereToClose()
        {
            while (ExtensionInstaller.IsPremiereRunning())
            {
                var answer = MessageBox.Show(this,
                    "Adobe Premiere Pro is currently open.\n\nPlease save your work, close Premiere Pro, then click Retry.",
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
                progressStatusLabel.Text = "Installing extension files...";
                var changed = installer.Install();
                var note = changed.Count > 0
                    ? " (Configured debug mode for " + string.Join(", ", changed) + ")"
                    : "";
                var done = "Extension installed successfully!" + note;
                if (!installer.Options.NoEngine && !engine.IsInstalled)
                {
                    StartEngineDownload(done);
                }
                else
                {
                    RefreshState(done);
                    progressStatusLabel.ForeColor = GreenSuccess;
                    MessageBox.Show(this,
                        "Better Captions installed successfully!\n\nLaunch Premiere Pro and go to Window > Extensions > Better Captions.",
                        "Setup Complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception e)
            {
                MessageBox.Show(this, "Installation failed:\n" + e.Message, "Better Captions", MessageBoxButtons.OK, MessageBoxIcon.Error);
                progressStatusLabel.Text = "Installation failed: " + e.Message;
                progressStatusLabel.ForeColor = Color.FromArgb(248, 113, 113);
            }
            finally
            {
                UseWaitCursor = false;
            }
        }

        void StartEngineDownload(string installedMessage)
        {
            downloading = true;
            installButton.Visible = false;
            openButton.Visible = false;
            uninstallButton.Visible = false;
            cancelButton.Visible = true;
            cancelButton.Enabled = true;

            modernProgress.Value = 0;
            modernProgress.Visible = true;
            progressStatusLabel.ForeColor = TextPrimary;
            progressStatusLabel.Text = "Downloading speech engine & AI model...";
            progressPercentLabel.Text = "0%";

            var worker = new Thread(delegate()
            {
                string result;
                bool ok = false;
                try
                {
                    engine.Run(delegate(string message, int percent)
                    {
                        OnUi(delegate { ShowProgress(message, percent); });
                    });
                    ok = true;
                    result = "Speech engine & Large v3 Turbo model ready! All captions work 100% offline.";
                }
                catch (OperationCanceledException)
                {
                    result = "Download cancelled. You can click Reinstall anytime to resume where you left off.";
                }
                catch (Exception e)
                {
                    result = "Download failed: " + e.Message + " (Click Reinstall to retry).";
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
            if (percent < 0)
            {
                modernProgress.StartMarquee();
                progressPercentLabel.Text = "";
            }
            else
            {
                modernProgress.StopMarquee();
                modernProgress.Value = percent;
                progressPercentLabel.Text = percent + "%";
            }
            progressStatusLabel.Text = message;
        }

        void FinishDownload(string message, bool ok)
        {
            downloading = false;
            modernProgress.Visible = false;
            cancelButton.Visible = false;
            installButton.Visible = true;
            openButton.Visible = true;
            uninstallButton.Visible = true;

            RefreshState(null);
            progressStatusLabel.Text = message;
            progressStatusLabel.ForeColor = ok ? GreenSuccess : Color.FromArgb(248, 113, 113);

            if (ok)
            {
                MessageBox.Show(this,
                    "Better Captions and the Offline AI Engine are ready!\n\nOpen Premiere Pro → Window → Extensions → Better Captions.",
                    "Installation Complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                System.Media.SystemSounds.Exclamation.Play();
            }
        }

        void CancelDownload()
        {
            cancelButton.Enabled = false;
            progressStatusLabel.Text = "Stopping download...";
            engine.Cancel();
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!downloading) return;
            var answer = MessageBox.Show(this,
                "The speech engine is currently downloading.\n\nDo you want to stop the download and exit?\n(The panel is already installed; setup will resume where it stopped if re-opened).",
                "Better Captions Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer == DialogResult.Yes) engine.Cancel();
            else e.Cancel = true;
        }

        void RunUninstall()
        {
            if (installer.InstalledVersion == null)
            {
                RefreshState("Better Captions is not installed.");
                return;
            }
            if (!WaitForPremiereToClose()) return;

            var removeData = false;
            if (Directory.Exists(ExtensionInstaller.EngineDataDir))
            {
                var answer = MessageBox.Show(this,
                    "Do you also want to delete the downloaded speech engine and saved caption presets?\n\nChoose 'No' to keep them so you won't need to re-download if you install again in the future.",
                    "Uninstall Better Captions", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (answer == DialogResult.Cancel) return;
                removeData = answer == DialogResult.Yes;
            }

            try
            {
                installer.Uninstall(removeData);
                RefreshState("Better Captions has been removed.");
                progressStatusLabel.Text = "Better Captions was uninstalled.";
                progressStatusLabel.ForeColor = AmberWarning;
            }
            catch (Exception e)
            {
                MessageBox.Show(this, "Uninstall failed:\n" + e.Message, "Better Captions", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        void OpenPremiere()
        {
            var exe = ExtensionInstaller.FindPremiere();
            if (exe == null)
            {
                MessageBox.Show(this, "Premiere Pro was not found in standard Program Files paths.", "Better Captions");
                return;
            }
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            progressStatusLabel.Text = "Opening Premiere Pro... Go to Window > Extensions > Better Captions.";
        }
    }
}
