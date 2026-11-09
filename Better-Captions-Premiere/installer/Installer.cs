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

    #region UI controls

    // Same tokens as the panel (webview-ui/src/app.css): Premiere's greys and
    // one accent, Premiere's selection blue.
    static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(35, 35, 35);
        public static readonly Color Surface = Color.FromArgb(42, 42, 42);
        public static readonly Color Raised = Color.FromArgb(51, 51, 51);
        public static readonly Color Overlay = Color.FromArgb(62, 62, 62);
        public static readonly Color Border = Color.FromArgb(58, 58, 58);
        public static readonly Color Text = Color.FromArgb(227, 227, 227);
        public static readonly Color Secondary = Color.FromArgb(163, 163, 163);
        public static readonly Color Tertiary = Color.FromArgb(124, 124, 124);
        public static readonly Color Accent = Color.FromArgb(38, 128, 235);
        public static readonly Color AccentHover = Color.FromArgb(55, 142, 240);
        public static readonly Color Success = Color.FromArgb(51, 171, 132);
        public static readonly Color Warning = Color.FromArgb(230, 134, 25);
        public static readonly Color Error = Color.FromArgb(240, 86, 75);

        public static Font Body(float size) { return new Font("Segoe UI", size, FontStyle.Regular); }
        public static Font Strong(float size) { return new Font("Segoe UI Semibold", size, FontStyle.Regular); }
    }

    public static class GraphicsUtils
    {
        public static GraphicsPath CreateRoundedRectangle(Rectangle bounds, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            if (d <= 0)
            {
                path.AddRectangle(bounds);
                return path;
            }
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static Pen IconPen(Color color, float width)
        {
            var pen = new Pen(color, width);
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            pen.LineJoin = LineJoin.Round;
            return pen;
        }
    }

    // Line icons drawn in the style of the Lucide set the panel uses
    // (24-unit grid, round caps), scaled to the control.
    public enum IconKind { Captions, CircleCheck, CircleDashed, Alert, Download, Film, Panel, Waveform }

    public class LineIcon : Control
    {
        IconKind kind;
        public IconKind Kind { get { return kind; } set { kind = value; Invalidate(); } }

        public LineIcon()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
            BackColor = Color.Transparent;
            Size = new Size(18, 18);
        }

        protected override void OnForeColorChanged(EventArgs e)
        {
            base.OnForeColorChanged(e);
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float s = Math.Min(Width, Height) / 24f;
            g.ScaleTransform(s, s);
            using (var pen = GraphicsUtils.IconPen(ForeColor, 1.75f))
            {
                switch (kind)
                {
                    case IconKind.Captions:
                        g.DrawPath(pen, GraphicsUtils.CreateRoundedRectangle(new Rectangle(3, 5, 18, 14), 2));
                        g.DrawLine(pen, 7, 15, 11, 15);
                        g.DrawLine(pen, 14, 15, 17, 15);
                        g.DrawLine(pen, 7, 11, 9, 11);
                        g.DrawLine(pen, 12, 11, 17, 11);
                        break;
                    case IconKind.CircleCheck:
                        g.DrawEllipse(pen, 2, 2, 20, 20);
                        g.DrawLines(pen, new[] { new PointF(8, 12), new PointF(11, 15), new PointF(16, 9) });
                        break;
                    case IconKind.CircleDashed:
                        pen.DashPattern = new[] { 1.6f, 2.2f };
                        g.DrawEllipse(pen, 2, 2, 20, 20);
                        break;
                    case IconKind.Alert:
                        g.DrawEllipse(pen, 2, 2, 20, 20);
                        g.DrawLine(pen, 12, 7.5f, 12, 13);
                        g.DrawLine(pen, 12, 16.5f, 12.01f, 16.5f);
                        break;
                    case IconKind.Download:
                        g.DrawLine(pen, 12, 3, 12, 15);
                        g.DrawLines(pen, new[] { new PointF(7, 10), new PointF(12, 15), new PointF(17, 10) });
                        g.DrawLines(pen, new[] { new PointF(3, 15), new PointF(3, 19), new PointF(21, 19), new PointF(21, 15) });
                        break;
                    case IconKind.Film:
                        g.DrawPath(pen, GraphicsUtils.CreateRoundedRectangle(new Rectangle(3, 3, 18, 18), 2));
                        g.DrawLine(pen, 7, 3, 7, 21);
                        g.DrawLine(pen, 17, 3, 17, 21);
                        g.DrawLine(pen, 3, 12, 21, 12);
                        break;
                    case IconKind.Panel:
                        g.DrawPath(pen, GraphicsUtils.CreateRoundedRectangle(new Rectangle(3, 3, 18, 18), 2));
                        g.DrawLine(pen, 15, 3, 15, 21);
                        break;
                    case IconKind.Waveform:
                        g.DrawLines(pen, new[] { new PointF(2, 13), new PointF(4, 13), new PointF(7, 5), new PointF(11, 19), new PointF(14, 9), new PointF(17, 15), new PointF(19, 12), new PointF(22, 12) });
                        break;
                }
            }
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
            CornerRadius = 4;
            Cursor = Cursors.Hand;
            Font = Theme.Strong(9f);
            Size = new Size(120, 32);
        }

        protected override void OnMouseEnter(EventArgs e) { isHovered = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { isHovered = false; isPressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { isPressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { isPressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }

        protected override void OnPaint(PaintEventArgs pevent)
        {
            var g = pevent.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Surface);

            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            Color fill, border, text;
            if (IsPrimary)
            {
                fill = isPressed ? Theme.Accent : (isHovered ? Theme.AccentHover : Theme.Accent);
                border = fill;
                text = Color.White;
            }
            else
            {
                fill = isPressed ? Theme.Overlay : (isHovered ? Color.FromArgb(61, 61, 61) : Theme.Raised);
                border = Theme.Border;
                text = IsDestructive && isHovered ? Theme.Error : Theme.Text;
            }
            if (!Enabled)
            {
                fill = Theme.Raised;
                border = Theme.Border;
                text = Theme.Tertiary;
            }

            using (var path = GraphicsUtils.CreateRoundedRectangle(rect, CornerRadius))
            {
                using (var brush = new SolidBrush(fill)) g.FillPath(brush, path);
                using (var pen = new Pen(border, 1f)) g.DrawPath(pen, path);
            }
            TextRenderer.DrawText(g, Text, Font, rect, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);

            if (Focused && ShowFocusCues)
            {
                var focus = new Rectangle(1, 1, Width - 3, Height - 3);
                using (var path = GraphicsUtils.CreateRoundedRectangle(focus, CornerRadius))
                using (var pen = new Pen(IsPrimary ? Color.White : Theme.Accent, 1.5f))
                    g.DrawPath(pen, path);
            }
        }
    }

    public class ModernProgressBar : Control
    {
        int val;
        public int Value
        {
            get { return val; }
            set { val = Math.Max(0, Math.Min(100, value)); Invalidate(); }
        }

        public bool IsMarquee { get; private set; }
        int marqueeOffset;
        System.Windows.Forms.Timer marqueeTimer;

        public ModernProgressBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Height = 4;
        }

        public void StartMarquee()
        {
            IsMarquee = true;
            if (marqueeTimer == null)
            {
                marqueeTimer = new System.Windows.Forms.Timer { Interval = 30 };
                marqueeTimer.Tick += delegate
                {
                    marqueeOffset = (marqueeOffset + 5) % (Width + Width / 3);
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
            g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
            using (var track = new SolidBrush(Theme.Raised)) g.FillRectangle(track, 0, 0, Width, Height);
            using (var fill = new SolidBrush(Theme.Accent))
            {
                if (IsMarquee)
                {
                    int bar = Math.Max(40, Width / 3);
                    int x = marqueeOffset - bar;
                    int left = Math.Max(0, x);
                    int right = Math.Min(Width, x + bar);
                    if (right > left) g.FillRectangle(fill, left, 0, right - left, Height);
                }
                else if (Value > 0)
                {
                    g.FillRectangle(fill, 0, 0, (int)(Width * (Value / 100.0)), Height);
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && marqueeTimer != null) marqueeTimer.Dispose();
            base.Dispose(disposing);
        }
    }

    // One line of the status list: icon, title and a detail line.
    class StatusRow : Panel
    {
        public readonly LineIcon Icon;
        public readonly Label Title;
        public readonly Label Detail;
        public bool DrawDivider;

        public StatusRow(IconKind kind, string title, int width)
        {
            Size = new Size(width, 48);
            BackColor = Theme.Surface;
            Icon = new LineIcon { Kind = kind, Location = new Point(14, 15), Size = new Size(18, 18), ForeColor = Theme.Secondary };
            Title = new Label
            {
                Text = title, Location = new Point(44, 7), Size = new Size(width - 58, 18),
                ForeColor = Theme.Text, Font = Theme.Strong(9f), UseMnemonic = false, BackColor = Color.Transparent,
            };
            Detail = new Label
            {
                Location = new Point(44, 25), Size = new Size(width - 58, 18),
                ForeColor = Theme.Secondary, Font = Theme.Body(8.75f), UseMnemonic = false, BackColor = Color.Transparent,
                AutoEllipsis = true,
            };
            Controls.Add(Icon);
            Controls.Add(Title);
            Controls.Add(Detail);
        }

        public void Set(IconKind kind, Color iconColor, string detail)
        {
            Icon.Kind = kind;
            Icon.ForeColor = iconColor;
            Detail.Text = detail;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (!DrawDivider) return;
            using (var pen = new Pen(Theme.Border, 1f)) e.Graphics.DrawLine(pen, 0, 0, Width, 0);
        }
    }

    #endregion

    class InstallerForm : Form
    {
        readonly ExtensionInstaller installer;
        readonly EngineDownloader engine;

        readonly StatusRow premiereRow;
        readonly StatusRow panelRow;
        readonly StatusRow engineRow;

        readonly Label statusLabel;
        readonly Label percentLabel;
        readonly ModernProgressBar progress;

        readonly ModernButton installButton;
        readonly ModernButton uninstallButton;
        readonly ModernButton openButton;
        readonly ModernButton cancelButton;

        bool downloading;

        const int Pad = 20;
        const int W = 520;

        public InstallerForm(ExtensionInstaller installer, bool startWithUninstall)
        {
            this.installer = installer;
            engine = new EngineDownloader(installer.Options.EngineDir);

            Text = "Better Captions Setup";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(W, 404);
            Font = Theme.Body(9f);
            BackColor = Theme.Bg;
            ForeColor = Theme.Text;
            DoubleBuffered = true;
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

            // Header: the panel's captions glyph, the name and what it is.
            Controls.Add(new LineIcon { Kind = IconKind.Captions, Location = new Point(Pad, 22), Size = new Size(28, 28), ForeColor = Theme.Text });
            Controls.Add(new Label
            {
                Text = "Better Captions", Location = new Point(Pad + 40, 18), AutoSize = true,
                ForeColor = Theme.Text, Font = Theme.Strong(12f), UseMnemonic = false,
            });
            Controls.Add(new Label
            {
                Text = "Offline captions, beat markers and LUT preview for Premiere Pro. Version " + (installer.PackagedVersion ?? "?"),
                Location = new Point(Pad + 41, 42), Size = new Size(W - Pad * 2 - 41, 18),
                ForeColor = Theme.Secondary, Font = Theme.Body(8.75f), UseMnemonic = false,
            });

            // Status list.
            int listW = W - Pad * 2;
            var list = new Panel { Location = new Point(Pad, 78), Size = new Size(listW, 48 * 3 + 2), BackColor = Theme.Border };
            premiereRow = new StatusRow(IconKind.Film, "Premiere Pro", listW - 2) { Location = new Point(1, 1) };
            panelRow = new StatusRow(IconKind.Panel, "Better Captions panel", listW - 2) { Location = new Point(1, 49), DrawDivider = true };
            engineRow = new StatusRow(IconKind.Waveform, "Offline speech engine", listW - 2) { Location = new Point(1, 97), DrawDivider = true };
            list.Controls.Add(premiereRow);
            list.Controls.Add(panelRow);
            list.Controls.Add(engineRow);
            list.Paint += delegate(object s, PaintEventArgs pe)
            {
                // Rounded 1px frame around the rows.
                var g = pe.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Theme.Bg);
                using (var path = GraphicsUtils.CreateRoundedRectangle(new Rectangle(0, 0, list.Width - 1, list.Height - 1), 6))
                {
                    using (var brush = new SolidBrush(Theme.Surface)) g.FillPath(brush, path);
                    using (var pen = new Pen(Theme.Border, 1f)) g.DrawPath(pen, path);
                }
            };
            Controls.Add(list);

            Controls.Add(new Label
            {
                Text = "Installs to " + installer.TargetDir,
                Location = new Point(Pad, 232), Size = new Size(listW, 18), AutoEllipsis = true,
                ForeColor = Theme.Tertiary, Font = Theme.Body(8.25f), UseMnemonic = false,
            });

            // What's happening now, with the download progress.
            statusLabel = new Label
            {
                Location = new Point(Pad, 268), Size = new Size(listW - 60, 36),
                ForeColor = Theme.Text, Font = Theme.Body(9f), UseMnemonic = false,
            };
            percentLabel = new Label
            {
                Location = new Point(W - Pad - 60, 268), Size = new Size(60, 18), TextAlign = ContentAlignment.TopRight,
                ForeColor = Theme.Secondary, Font = Theme.Body(9f), UseMnemonic = false,
            };
            progress = new ModernProgressBar { Location = new Point(Pad, 308), Size = new Size(listW, 4), Visible = false };
            Controls.Add(statusLabel);
            Controls.Add(percentLabel);
            Controls.Add(progress);

            // Buttons along the bottom.
            var bar = new Panel { Dock = DockStyle.Bottom, Height = 60, BackColor = Theme.Surface };
            bar.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (var pen = new Pen(Theme.Border, 1f)) pe.Graphics.DrawLine(pen, 0, 0, bar.Width, 0);
            };
            uninstallButton = new ModernButton { Text = "Uninstall", Location = new Point(Pad, 14), Size = new Size(96, 32), IsDestructive = true };
            uninstallButton.Click += delegate { RunUninstall(); };
            openButton = new ModernButton { Text = "Open Premiere Pro", Location = new Point(W - Pad - 120 - 8 - 140, 14), Size = new Size(140, 32) };
            openButton.Click += delegate { OpenPremiere(); };
            installButton = new ModernButton { Text = "Install", Location = new Point(W - Pad - 120, 14), Size = new Size(120, 32), IsPrimary = true };
            installButton.Click += delegate { RunInstall(); };
            cancelButton = new ModernButton { Text = "Cancel", Location = new Point(W - Pad - 120, 14), Size = new Size(120, 32), Visible = false };
            cancelButton.Click += delegate { CancelDownload(); };
            bar.Controls.Add(uninstallButton);
            bar.Controls.Add(openButton);
            bar.Controls.Add(installButton);
            bar.Controls.Add(cancelButton);
            Controls.Add(bar);

            FormClosing += OnFormClosing;
            AcceptButton = installButton;

            RefreshState(null);
            if (startWithUninstall) Shown += delegate { RunUninstall(); };
        }

        void SetStatus(string text, Color color)
        {
            statusLabel.Text = text;
            statusLabel.ForeColor = color;
        }

        void RefreshState(string message)
        {
            var premiereExe = ExtensionInstaller.FindPremiere();
            if (premiereExe != null)
                premiereRow.Set(IconKind.CircleCheck, Theme.Success, "Found " + Path.GetFileName(Path.GetDirectoryName(premiereExe)));
            else
                premiereRow.Set(IconKind.Alert, Theme.Warning, "Not found in Program Files\\Adobe. The panel still installs.");

            var installed = installer.InstalledVersion;
            var packaged = installer.PackagedVersion;
            if (installed != null)
                panelRow.Set(IconKind.CircleCheck, Theme.Success, "Installed, version " + installed + (installed != packaged ? " (this setup has " + packaged + ")" : ""));
            else
                panelRow.Set(IconKind.CircleDashed, Theme.Tertiary, "Not installed yet");
            installButton.Text = installed == null ? "Install" : "Reinstall";
            uninstallButton.Enabled = installed != null;
            openButton.Enabled = installed != null && premiereExe != null;

            if (engine.IsInstalled)
                engineRow.Set(IconKind.CircleCheck, Theme.Success, "Installed, with the Large v3 Turbo model");
            else if (installer.Options.NoEngine)
                engineRow.Set(IconKind.Alert, Theme.Warning, "Skipped (/noengine). The panel's setup button can download it.");
            else
                engineRow.Set(IconKind.Download, Theme.Secondary, "Downloads after the panel installs, about " + Math.Max(1, engine.RemainingBytes / 1000000) + " MB, one time");

            if (message != null) SetStatus(message, Theme.Text);
            else if (installed == null) SetStatus("Close Premiere Pro, then click Install.", Theme.Secondary);
            else SetStatus("In Premiere Pro, open Window > Extensions > Better Captions.", Theme.Secondary);
            percentLabel.Text = "";
        }

        bool WaitForPremiereToClose()
        {
            while (ExtensionInstaller.IsPremiereRunning())
            {
                var answer = MessageBox.Show(this,
                    "Premiere Pro is open. Save your work, close Premiere Pro, then click Retry.",
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
                SetStatus("Installing the panel...", Theme.Text);
                Application.DoEvents();
                var changed = installer.Install();
                var note = changed.Count > 0 ? " Unsigned extensions were turned on for " + string.Join(", ", changed) + "." : "";
                var done = "Panel installed." + note;
                if (!installer.Options.NoEngine && !engine.IsInstalled)
                {
                    StartEngineDownload(done);
                }
                else
                {
                    RefreshState(null);
                    SetStatus(done + " In Premiere Pro, open Window > Extensions > Better Captions.", Theme.Success);
                }
            }
            catch (Exception e)
            {
                SetStatus("Install failed: " + e.Message, Theme.Error);
                System.Media.SystemSounds.Exclamation.Play();
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
            AcceptButton = null;

            progress.Value = 0;
            progress.Visible = true;
            SetStatus(installedMessage + " Downloading the speech engine...", Theme.Text);
            percentLabel.Text = "0%";
            engineRow.Set(IconKind.Download, Theme.Accent, "Downloading...");

            var worker = new Thread(delegate()
            {
                string result;
                bool ok = false;
                try
                {
                    engine.Run(delegate(string message, int percent) { OnUi(delegate { ShowProgress(message, percent); }); });
                    ok = true;
                    result = "Ready. Captions now work without internet. In Premiere Pro, open Window > Extensions > Better Captions.";
                }
                catch (OperationCanceledException)
                {
                    result = "Download stopped. The panel is installed; click Reinstall to finish the download from where it stopped.";
                }
                catch (Exception e)
                {
                    result = "The speech engine couldn't be downloaded: " + e.Message + " Check your connection and click Reinstall, or use Set up offline engine in the panel.";
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
                progress.StartMarquee();
                percentLabel.Text = "";
            }
            else
            {
                progress.StopMarquee();
                progress.Value = percent;
                percentLabel.Text = percent + "%";
            }
            SetStatus(message, Theme.Text);
        }

        void FinishDownload(string message, bool ok)
        {
            downloading = false;
            progress.StopMarquee();
            progress.Visible = false;
            cancelButton.Visible = false;
            installButton.Visible = true;
            openButton.Visible = true;
            uninstallButton.Visible = true;
            AcceptButton = installButton;
            RefreshState(null);
            SetStatus(message, ok ? Theme.Success : Theme.Warning);
            if (!ok) System.Media.SystemSounds.Exclamation.Play();
        }

        void CancelDownload()
        {
            cancelButton.Enabled = false;
            SetStatus("Stopping the download...", Theme.Text);
            engine.Cancel();
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!downloading) return;
            var answer = MessageBox.Show(this,
                "The speech engine is still downloading. Stop and close?\n\nThe panel is already installed. Run setup again later to finish the download; it continues where it stopped.",
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
                    "Also delete the downloaded speech engine, saved captions and presets?\n\nChoose No to keep them, so you won't need to download them again if you reinstall.",
                    "Uninstall Better Captions", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (answer == DialogResult.Cancel) return;
                removeData = answer == DialogResult.Yes;
            }

            try
            {
                installer.Uninstall(removeData);
                RefreshState(null);
                SetStatus("Better Captions was uninstalled.", Theme.Text);
            }
            catch (Exception e)
            {
                SetStatus("Uninstall failed: " + e.Message, Theme.Error);
                System.Media.SystemSounds.Exclamation.Play();
            }
        }

        void OpenPremiere()
        {
            var exe = ExtensionInstaller.FindPremiere();
            if (exe == null)
            {
                SetStatus("Premiere Pro wasn't found in Program Files\\Adobe.", Theme.Warning);
                return;
            }
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            SetStatus("Starting Premiere Pro. When it opens, go to Window > Extensions > Better Captions.", Theme.Secondary);
        }
    }
}
