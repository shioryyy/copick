// 真实应用的取词兼容性驱动：对目标窗口做一次鼠标拖选，检查 Copick 浮窗是否出现、
// 点击后剪贴板是否拿到所选文字。仅由 verify-windows-apps.ps1 在交互桌面调用。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class AppCompatibility
{
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref POINT point);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);

    delegate bool EnumProc(IntPtr window, IntPtr state);
    const int SW_RESTORE = 9;

    static string title;
    static int prototypePid;
    static string output;

    static string TitleOf(IntPtr window)
    {
        var text = new StringBuilder(512);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    static IntPtr FindTarget()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr state)
        {
            if (!IsWindowVisible(window)) return true;
            if (TitleOf(window).IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // 浮窗是原型进程里 88x40（按缩放放大）的无边框窗口；设置窗口 620x720 不会落进这个范围。
    static IntPtr FindPopup()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr state)
        {
            uint pid; GetWindowThreadProcessId(window, out pid);
            RECT bounds;
            if (pid != prototypePid || !IsWindowVisible(window) || !GetWindowRect(window, out bounds)) return true;
            int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
            if (width >= 80 && width <= 300 && height >= 35 && height <= 200) { found = window; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // 必须用 SendInput 的绝对移动：SetCursorPos 产生的移动不会进入产品的低级鼠标钩子，
    // 拖动会被判定成单击（gesture=0）。
    static void MoveTo(POINT point)
    {
        var desktop = SystemInformation.VirtualScreen;
        var input = new INPUT { type = 0 };
        input.mi.dwFlags = 0x8000 | 0x4000 | 0x0001;
        input.mi.dx = (int)((long)(point.X - desktop.Left) * 65535 / (desktop.Width - 1));
        input.mi.dy = (int)((long)(point.Y - desktop.Top) * 65535 / (desktop.Height - 1));
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("鼠标移动输入失败");
    }

    static void Drag(POINT from, POINT to)
    {
        MoveTo(from);
        Thread.Sleep(150);
        SendInput(1, new[] { Mouse(2) }, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(80);
        for (int step = 1; step <= 15; step++)
        {
            MoveTo(new POINT { X = from.X + (to.X - from.X) * step / 15, Y = from.Y + (to.Y - from.Y) * step / 15 });
            Thread.Sleep(25);
        }
        Thread.Sleep(60);
        SendInput(1, new[] { Mouse(4) }, Marshal.SizeOf(typeof(INPUT)));
    }

    static INPUT Mouse(uint flag)
    {
        var input = new INPUT { type = 0 };
        input.mi.dwFlags = flag;
        return input;
    }

    static string ReadClipboard()
    {
        for (int attempt = 0; attempt < 12; ++attempt)
        {
            try
            {
                if (Clipboard.ContainsText()) return Clipboard.GetText();
            }
            catch { }
            Thread.Sleep(120);
        }
        return null;
    }

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length != 5) { Console.WriteLine("usage: <report> <prototypePid> <title> <popup|none> <clipboardFile>"); return 2; }
        output = args[0];
        prototypePid = int.Parse(args[1]);
        title = args[2];
        string expect = args[3];
        string clipboardFile = args[4];
        var report = new Dictionary<string, object>();
        bool passed = false;
        string error = null;
        try
        {
            IntPtr target = IntPtr.Zero;
            for (int attempt = 0; attempt < 50 && target == IntPtr.Zero; ++attempt)
            {
                target = FindTarget();
                if (target == IntPtr.Zero) Thread.Sleep(200);
            }
            if (target == IntPtr.Zero) throw new InvalidOperationException("未找到标题包含「" + title + "」的窗口");
            report["targetTitle"] = TitleOf(target);
            ShowWindow(target, SW_RESTORE);
            SetForegroundWindow(target);
            Thread.Sleep(600);
            report["targetForeground"] = GetForegroundWindow() == target;

            RECT client;
            GetClientRect(target, out client);
            report["clientWidth"] = client.Right;
            report["clientHeight"] = client.Bottom;
            // 现代记事本等应用的正文不在客户区顶部：按几个纵向位置各试一次。
            int[] offsets = { 20, 60, 100, 150, 220 };
            IntPtr popup = IntPtr.Zero;
            int attempts = 0;
            foreach (int top in offsets)
            {
                if (top > client.Bottom - 20) continue;
                var from = new POINT { X = 24, Y = top };
                var to = new POINT { X = Math.Min(client.Right - 40, 24 + 320), Y = top + 24 };
                ClientToScreen(target, ref from);
                ClientToScreen(target, ref to);
                attempts++;
                if (GetForegroundWindow() != target) { SetForegroundWindow(target); Thread.Sleep(300); }
                Drag(from, to);
                var deadline = DateTime.UtcNow.AddSeconds(2.5);
                while (DateTime.UtcNow < deadline && popup == IntPtr.Zero)
                {
                    popup = FindPopup();
                    if (popup == IntPtr.Zero) Thread.Sleep(150);
                }
                if (popup != IntPtr.Zero || expect == "none") break;
            }
            report["dragAttempts"] = attempts;
            report["popupShown"] = popup != IntPtr.Zero;
            if (expect == "none")
            {
                passed = popup == IntPtr.Zero;
                report["expectation"] = "no popup for a blocked program";
            }
            else
            {
                if (popup == IntPtr.Zero) throw new InvalidOperationException("拖选后没有出现浮窗");
                RECT bounds; GetWindowRect(popup, out bounds);
                report["popupBounds"] = bounds.Left + "," + bounds.Top + "," + (bounds.Right - bounds.Left) + "x" + (bounds.Bottom - bounds.Top);
                bool focused = GetForegroundWindow() == target;
                report["sourceFocusedBeforeClick"] = focused;
                var center = new POINT { X = (bounds.Left + bounds.Right) / 2, Y = (bounds.Top + bounds.Bottom) / 2 };
                SetCursorPos(center.X, center.Y);
                Thread.Sleep(100);
                SendInput(1, new[] { Mouse(2) }, Marshal.SizeOf(typeof(INPUT)));
                SendInput(1, new[] { Mouse(4) }, Marshal.SizeOf(typeof(INPUT)));
                string text = ReadClipboard();
                report["clipboardText"] = text;
                if (text != null && clipboardFile != null) System.IO.File.WriteAllText(clipboardFile, text, new UTF8Encoding(false));
                // 复制成功后浮窗还要 650ms 才过期隐藏，等待而不是立刻判定。
                var hideDeadline = DateTime.UtcNow.AddSeconds(3);
                while (DateTime.UtcNow < hideDeadline && IsWindowVisible(popup)) Thread.Sleep(100);
                report["popupHiddenAfterClick"] = !IsWindowVisible(popup);
                passed = focused && !string.IsNullOrWhiteSpace(text) && (bool)report["popupHiddenAfterClick"];
                report["expectation"] = "popup shown, click copies the selection, popup hides";
            }
        }
        catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
        report["passed"] = passed;
        if (error != null) report["error"] = error;
        var json = new StringBuilder("{");
        foreach (var pair in report)
        {
            if (json.Length > 1) json.Append(',');
            json.Append('"').Append(pair.Key).Append("\":");
            if (pair.Value == null) json.Append("null");
            else if (pair.Value is bool) json.Append((bool)pair.Value ? "true" : "false");
            else if (pair.Value is int) json.Append(pair.Value);
            else json.Append('"').Append(pair.Value.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n")).Append('"');
        }
        json.Append('}');
        Console.WriteLine(json.ToString());
        System.IO.File.WriteAllText(output, json.ToString(), new UTF8Encoding(false));
        return passed ? 0 : 1;
    }
}
