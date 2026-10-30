// 设置页「未保存草稿」关闭确认的真机验证驱动。
// 仅由 verify-windows-settings.ps1 在交互桌面调用；不参与产品构建。
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

static class SettingsCloseCheck
{
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);

    const uint WM_CLOSE = 0x0010;

    static AutomationElement WaitFor(AutomationElement root, Condition condition, int milliseconds)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < deadline)
        {
            AutomationElement found = root.FindFirst(TreeScope.Descendants, condition);
            if (found != null) return found;
            Thread.Sleep(150);
        }
        return null;
    }

    static IntPtr FindWindow(int pid)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            foreach (Process process in Process.GetProcessesByName("copick-tauri-prototype"))
            {
                if (process.Id != pid) continue;
                process.Refresh();
                IntPtr handle = process.MainWindowHandle;
                if (handle != IntPtr.Zero && process.MainWindowTitle.IndexOf("Copick", StringComparison.Ordinal) >= 0) return handle;
            }
            Thread.Sleep(200);
        }
        return IntPtr.Zero;
    }

    static void Toggle(AutomationElement element)
    {
        object pattern;
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return; }
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return; }
        throw new InvalidOperationException("开关不支持 Toggle/Invoke");
    }

    static int Main(string[] args)
    {
        int pid = args.Length > 0 ? int.Parse(args[0]) : 0;
        bool windowFound = false, checkboxFound = false, toggled = false;
        bool blockedOnClose = false, warningShown = false, discardFound = false, hiddenAfterDiscard = false;
        string error = null;
        string tree = null;
        try
        {
            IntPtr window = FindWindow(pid);
            windowFound = window != IntPtr.Zero;
            if (!windowFound) throw new InvalidOperationException("未找到设置窗口");
            SetForegroundWindow(window);
            AutomationElement root = AutomationElement.FromHandle(window);
            AutomationElement diagnostics = WaitFor(root, new PropertyCondition(AutomationElement.AutomationIdProperty, "diagnostics"), 20000);
            checkboxFound = diagnostics != null;
            if (!checkboxFound) throw new InvalidOperationException("未找到诊断开关");
            // 设置尚未加载完成时控件是禁用的，点击不会产生草稿。
            var enabledDeadline = DateTime.UtcNow.AddSeconds(15);
            while (!diagnostics.Current.IsEnabled && DateTime.UtcNow < enabledDeadline) Thread.Sleep(150);
            if (!diagnostics.Current.IsEnabled) throw new InvalidOperationException("诊断开关始终禁用");
            Toggle(diagnostics);
            toggled = true;
            Thread.Sleep(600);

            PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            Thread.Sleep(1500);
            blockedOnClose = IsWindowVisible(window);

            // WebView2 把 DOM id 暴露为 AutomationId，名称则取决于无障碍树是否完整。
            AutomationElement warning = WaitFor(root, new PropertyCondition(AutomationElement.AutomationIdProperty, "close-warning"), 4000)
                ?? WaitFor(root, new PropertyCondition(AutomationElement.NameProperty, "未保存的更改"), 1000);
            warningShown = warning != null;
            if (!warningShown)
            {
                // 失败时输出可见元素的名称，区分“事件没到”和“文案/树结构不同”。
                var names = new System.Collections.Generic.List<string>();
                AutomationElementCollection all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                foreach (AutomationElement element in all)
                {
                    string name = element.Current.Name;
                    if (!string.IsNullOrEmpty(name)) names.Add(name);
                    if (names.Count >= 60) break;
                }
                tree = string.Join(" | ", names.ToArray());
            }

            AutomationElement discard = WaitFor(root, new PropertyCondition(AutomationElement.AutomationIdProperty, "close-discard"), 4000)
                ?? WaitFor(root, new PropertyCondition(AutomationElement.NameProperty, "放弃并关闭"), 1000);
            discardFound = discard != null;
            if (discardFound)
            {
                ((InvokePattern)discard.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                Thread.Sleep(1500);
                hiddenAfterDiscard = !IsWindowVisible(window);
            }
        }
        catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }

        string result = "{\"windowFound\":" + (windowFound ? "true" : "false")
            + ",\"checkboxFound\":" + (checkboxFound ? "true" : "false")
            + ",\"toggled\":" + (toggled ? "true" : "false")
            + ",\"blockedOnClose\":" + (blockedOnClose ? "true" : "false")
            + ",\"warningShown\":" + (warningShown ? "true" : "false")
            + ",\"discardFound\":" + (discardFound ? "true" : "false")
            + ",\"hiddenAfterDiscard\":" + (hiddenAfterDiscard ? "true" : "false")
            + ",\"error\":" + (error == null ? "null" : "\"" + error.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"")
            + ",\"tree\":" + (tree == null ? "null" : "\"" + tree.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"")
            + "}";
        Console.WriteLine(result);
        bool passed = windowFound && checkboxFound && toggled && blockedOnClose && warningShown && discardFound && hiddenAfterDiscard;
        return passed ? 0 : 1;
    }
}
