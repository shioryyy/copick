// Tauri 版 Windows 安装包的真机验证驱动：安装 → 启动 → 登录启动项 → 卸载。
// 仅由 verify-windows-installer.ps1 在交互桌面调用；不参与产品构建。
//
// 与 Electron 版 ci.yml 里的同名检查的区别：这里逐项断言并把结果写成 JSON，
// 而不是让 PowerShell 在中途 throw —— 卸载之后 PowerShell 本身可能已被 NSIS
// 清理掉临时目录，输出会丢失，JSON 落在用户目录下才能被读回。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Microsoft.Win32;
using System.Windows.Automation;

static class InstallerCheck
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    // 与 src-tauri/src/startup.rs 的 NAME 保持一致；改名必须同时改两处。
    const string ValueName = "CopickTauri";
    const string ConfigDirectory = "local.copick.tauri";
    const string ProcessName = "copick-tauri-prototype";

    static readonly List<string> steps = new List<string>();
    static readonly Dictionary<string, object> report = new Dictionary<string, object>();

    static void Step(string name, bool passed, string detail)
    {
        steps.Add(name + (passed ? "=ok" : "=FAIL") + (detail == null ? "" : " " + detail));
        report[name] = new Dictionary<string, object> { { "passed", passed }, { "detail", detail } };
        Console.WriteLine((passed ? "PASS " : "FAIL ") + name + (detail == null ? "" : ": " + detail));
    }

    static IntPtr FindWindow(Process process)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            process.Refresh();
            IntPtr handle = process.MainWindowHandle;
            if (handle != IntPtr.Zero && process.MainWindowTitle.IndexOf("Copick", StringComparison.Ordinal) >= 0) return handle;
            System.Threading.Thread.Sleep(200);
        }
        return IntPtr.Zero;
    }

    // 设置页是 WebView2，控件通过 AutomationId 暴露；等页面加载完成才有。
    static AutomationElement WaitFor(IntPtr window, string automationId, int milliseconds)
    {
        AutomationElement root = AutomationElement.FromHandle(window);
        var condition = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
        var deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < deadline)
        {
            AutomationElement found = root.FindFirst(TreeScope.Descendants, condition);
            if (found != null) return found;
            System.Threading.Thread.Sleep(200);
        }
        return null;
    }

    static void Toggle(AutomationElement element)
    {
        object pattern;
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return; }
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return; }
        throw new InvalidOperationException("启动项开关不支持 Toggle/Invoke");
    }

    static string RunKeyValue()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey))
        {
            if (key == null) return null;
            object value = key.GetValue(ValueName);
            return value as string;
        }
    }

    static void RemoveRunValue()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, true))
        {
            if (key != null) key.DeleteValue(ValueName, false);
        }
    }

    static void KillProduct()
    {
        foreach (Process process in Process.GetProcessesByName(ProcessName))
        {
            try { process.Kill(); process.WaitForExit(5000); } catch { }
        }
    }

    // 等产品退出，避免安装/卸载时文件被占用。
    static bool WaitForExit(Process process, int milliseconds)
    {
        if (process == null) return true;
        try { return process.WaitForExit(milliseconds); } catch { return true; }
    }

    static string Smoke(string executable)
    {
        var info = new ProcessStartInfo(executable, "--smoke-test")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        using (Process process = Process.Start(info))
        {
            string output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(30000);
            return output.Trim();
        }
    }

    static int Main(string[] args)
    {
        // 参数：安装包路径、安装目录、报告路径。
        if (args.Length != 3) { Console.Error.WriteLine("usage: InstallerCheck <setup.exe> <install-dir> <report.json>"); return 2; }
        string setup = args[0], target = args[1], reportPath = args[2];
        report["setup"] = setup;
        report["installDir"] = target;
        bool ok = true;

        // 前置：清掉可能存在的旧安装与启动项，让结果只反映本次安装。
        KillProduct();
        RemoveRunValue();
        if (Directory.Exists(target)) Directory.Delete(target, true);

        // 1. 静默安装。NSIS 要求 /D 是最后一个参数且不加引号。
        var install = Process.Start(new ProcessStartInfo(setup, "/S /D=" + target) { UseShellExecute = false });
        bool installed = WaitForExit(install, 180000) && install.ExitCode == 0;
        string exe = Path.Combine(target, "Copick Tauri.exe");
        // Tauri 的 NSIS 安装目录里可执行文件名取 productName，不是包名。
        if (!File.Exists(exe)) exe = Directory.Exists(target)
            ? Directory.GetFiles(target, "*.exe").FirstOrDefault(name => Path.GetFileName(name).IndexOf("Copick", StringComparison.OrdinalIgnoreCase) >= 0)
            : null;
        Step("install", installed && exe != null, "exit=" + (install == null ? "?" : install.ExitCode.ToString()) + " exe=" + (exe ?? "missing"));
        if (exe == null) { ok = false; return Finish(reportPath, ok); }
        report["installedExe"] = exe;

        // 2. 安装后的二进制能跑起来（--smoke-test 不启动钩子、不弹窗）。
        string smoke = Smoke(exe);
        bool smokeOk = smoke.Contains("\"ok\":true");
        Step("installedSmoke", smokeOk, smoke.Length > 200 ? smoke.Substring(0, 200) : smoke);
        if (!smokeOk) ok = false;

        // 3. 登录启动项：产品只在用户点设置页开关时写注册表（不读配置），所以这里必须
        //    真的去点那个开关，而不是伪造配置文件。写一份“已暂停”的配置避免启动钩子。
        string configDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), ConfigDirectory);
        Directory.CreateDirectory(configDirectory);
        File.WriteAllText(Path.Combine(configDirectory, "config.json"),
            "{\"version\":1,\"paused\":true,\"clipboardFallback\":false,\"excludedApps\":[],\"diagnosticsEnabled\":false}", new UTF8Encoding(false));
        RemoveRunValue();
        // 不带 --background：要拿到设置窗口才能点启动项开关。配置里已暂停，不会启动钩子。
        Process app = Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false });
        string value = null;
        bool toggled = false, toggleBack = false;
        try
        {
            IntPtr window = FindWindow(app);
            if (window == IntPtr.Zero) { Step("launchAtLogin", false, "设置窗口没有出现"); ok = false; }
            else
            {
                AutomationElement startup = WaitFor(window, "startup", 25000);
                if (startup == null) { Step("launchAtLogin", false, "找不到启动项开关"); ok = false; }
                else
                {
                    var deadline = DateTime.UtcNow.AddSeconds(20);
                    while (!startup.Current.IsEnabled && DateTime.UtcNow < deadline) System.Threading.Thread.Sleep(200);
                    Toggle(startup);
                    toggled = true;
                    var appear = DateTime.UtcNow.AddSeconds(25);
                    while (DateTime.UtcNow < appear && string.IsNullOrEmpty(value))
                    {
                        value = RunKeyValue();
                        if (string.IsNullOrEmpty(value)) System.Threading.Thread.Sleep(250);
                    }
                    // 启动项必须指向本次安装路径，并且带 --background，否则登录时会弹出设置页。
                    bool startupOk = !string.IsNullOrEmpty(value)
                        && value.IndexOf(target, StringComparison.OrdinalIgnoreCase) >= 0
                        && value.IndexOf("--background", StringComparison.Ordinal) >= 0;
                    Step("launchAtLogin", startupOk, value ?? "Run value missing");
                    if (!startupOk) ok = false;
                    report["runValue"] = value;

                    // 4. 再点一次必须删掉，否则用户关不掉自启。
                    if (startupOk)
                    {
                        Toggle(startup);
                        toggleBack = true;
                        var removed = DateTime.UtcNow.AddSeconds(25);
                        while (DateTime.UtcNow < removed && !string.IsNullOrEmpty(RunKeyValue())) System.Threading.Thread.Sleep(250);
                        bool cleared = string.IsNullOrEmpty(RunKeyValue());
                        Step("launchAtLoginToggleOff", cleared, cleared ? "Run value removed" : RunKeyValue());
                        if (!cleared) ok = false;
                    }
                }
            }
        }
        catch (Exception error) { Step("launchAtLogin", false, error.Message); ok = false; }
        finally
        {
            KillProduct();
            WaitForExit(app, 10000);
        }
        report["toggled"] = toggled;
        report["toggledBack"] = toggleBack;

        // 5. 卸载。NSIS 的静默卸载参数是 /S 与 _?=<目录>。
        string uninstaller = Path.Combine(target, "uninstall.exe");
        if (!File.Exists(uninstaller))
        {
            uninstaller = Directory.GetFiles(target, "*.exe")
                .FirstOrDefault(name => Path.GetFileName(name).IndexOf("uninstall", StringComparison.OrdinalIgnoreCase) >= 0);
        }
        bool uninstalled = false;
        if (uninstaller == null) { Step("uninstall", false, "uninstaller not found"); ok = false; }
        else
        {
            var remove = Process.Start(new ProcessStartInfo(uninstaller, "/S _?=" + target) { UseShellExecute = false });
            WaitForExit(remove, 180000);
            // NSIS 卸载器会先复制自己再运行，退出码不可靠；以文件是否消失为准。
            var gone = DateTime.UtcNow.AddSeconds(30);
            while (DateTime.UtcNow < gone && File.Exists(exe)) System.Threading.Thread.Sleep(500);
            uninstalled = !File.Exists(exe);
            Step("uninstall", uninstalled, "exit=" + (remove == null ? "?" : remove.ExitCode.ToString()) + " exeStillThere=" + File.Exists(exe));
            if (!uninstalled) ok = false;
        }

        // 6. 卸载后启动项不应残留。Tauri 的卸载器不会主动清理 HKCU Run 值，
        //    因此这一项记录实际行为，而不是假定它已被清理。
        string leftover = RunKeyValue();
        report["runValueAfterUninstall"] = leftover;
        Step("runValueCleanedByUninstall", string.IsNullOrEmpty(leftover), leftover ?? "none");

        // 7. 覆盖升级：把同一个安装包再装一次到同一目录，模拟用户升级。
        //    产品此前已在跑（安装器会尝试结束它），这里重新确认安装后仍能启动。
        var reinstall = Process.Start(new ProcessStartInfo(setup, "/S /D=" + target) { UseShellExecute = false });
        bool reinstalled = WaitForExit(reinstall, 180000) && reinstall.ExitCode == 0;
        bool stillThere = File.Exists(exe);
        string resmoke = stillThere ? Smoke(exe) : "";
        bool upgradeOk = reinstalled && stillThere && resmoke.Contains("\"ok\":true");
        Step("reinstallOverExisting", upgradeOk,
            "exit=" + (reinstall == null ? "?" : reinstall.ExitCode.ToString()) + " exe=" + stillThere + " smoke=" + (resmoke.Length > 80 ? resmoke.Substring(0, 80) : resmoke));
        if (!upgradeOk) ok = false;

        // 收尾：无论结果如何都不要把测试配置留给用户。
        RemoveRunValue();
        KillProduct();
        try { if (Directory.Exists(configDirectory)) Directory.Delete(configDirectory, true); } catch { }
        return Finish(reportPath, ok);
    }

    static int Finish(string reportPath, bool ok)
    {
        report["passed"] = ok;
        report["steps"] = steps;
        string json = NewtonsoftFreeJson();
        Directory.CreateDirectory(Path.GetDirectoryName(reportPath));
        File.WriteAllText(reportPath, json, new UTF8Encoding(false));
        Console.WriteLine(json);
        return ok ? 0 : 1;
    }

    // 不引入 Newtonsoft：报告结构只有一层字典与字符串/布尔值，手写足够。
    static string NewtonsoftFreeJson()
    {
        var builder = new StringBuilder("{");
        bool first = true;
        foreach (var pair in report)
        {
            if (!first) builder.Append(',');
            first = false;
            builder.Append(Quote(pair.Key)).Append(':').Append(Value(pair.Value));
        }
        return builder.Append('}').ToString();
    }

    static string Value(object value)
    {
        if (value is bool) return (bool)value ? "true" : "false";
        if (value is string) return Quote((string)value);
        var list = value as IEnumerable<string>;
        if (list != null) return "[" + string.Join(",", list.Select(Quote)) + "]";
        var map = value as IDictionary<string, object>;
        if (map != null)
        {
            return "{" + string.Join(",", map.Select(pair => Quote(pair.Key) + ":" + Value(pair.Value))) + "}";
        }
        return "null";
    }

    static string Quote(string text)
    {
        if (text == null) return "null";
        var builder = new StringBuilder("\"");
        foreach (char c in text)
        {
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < ' ') builder.Append("\\u").Append(((int)c).ToString("x4"));
                    else builder.Append(c);
                    break;
            }
        }
        return builder.Append('"').ToString();
    }
}
