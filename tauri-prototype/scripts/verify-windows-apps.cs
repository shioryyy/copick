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
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    // 键盘和鼠标共用一块内存；按最大的那个（MOUSEINPUT）声明，避免 SendInput 长度不符。
    [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }

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
    // UIA 的 BoundingRectangle 永远用物理像素，而 GetClientRect/ClientToScreen 默认按
    // 进程 DPI 感知模式返回逻辑像素。不加这一行，150% 缩放下 1265 宽的窗口会算出
    // 1803 的右边界，拖拽点整个偏掉。
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    // .NET 的 Clipboard.SetText 用 OLE 延迟渲染，产品在 worker 线程里 EmptyClipboard 时
    // 会被这段渲染卡住两秒，直接把复制打成超时。用 Win32 剪贴板 API 立即交出数据。
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    const uint CF_UNICODETEXT = 13;
    const uint GMEM_MOVEABLE = 0x0002;

    delegate bool EnumProc(IntPtr window, IntPtr state);
    const int SW_RESTORE = 9;

    static string title;
    static int prototypePid;
    static string output;
    // 测试文档内容。剪贴板必须落在它里面才算复制成功：
    // 只检查“非空”会让上一次留下的无关内容冒充成功（2026-10-27 真机上就发生过，
    // 剪贴板里是别人的 Python 源码，判定却是 passed=true）。
    static string documentFile;

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

    static INPUT Key(ushort code, uint flag)
    {
        var input = new INPUT { type = 1 };
        input.ki.wVk = code;
        input.ki.dwFlags = flag;
        return input;
    }

    static string ReadClipboard()
    {
        for (int attempt = 0; attempt < 12; ++attempt)
        {
            if (OpenClipboard(IntPtr.Zero))
            {
                try
                {
                    if (IsClipboardFormatAvailable(CF_UNICODETEXT))
                    {
                        IntPtr handle = GetClipboardData(CF_UNICODETEXT);
                        if (handle != IntPtr.Zero)
                        {
                            IntPtr pointer = GlobalLock(handle);
                            if (pointer != IntPtr.Zero)
                            {
                                try { return Marshal.PtrToStringUni(pointer) ?? ""; }
                                finally { GlobalUnlock(handle); }
                            }
                        }
                        return "";
                    }
                }
                finally { CloseClipboard(); }
            }
            Thread.Sleep(120);
        }
        return null;
    }

    // 用哨兵覆盖剪贴板：产品没写时读回来的是它，而不是上一次残留的任意内容。
    static bool WriteClipboard(string value)
    {
        for (int attempt = 0; attempt < 12; ++attempt)
        {
            if (!OpenClipboard(IntPtr.Zero)) { Thread.Sleep(60); continue; }
            try
            {
                if (!EmptyClipboard()) { Thread.Sleep(60); continue; }
                int bytes = (value.Length + 1) * 2;
                IntPtr memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)(uint)bytes);
                if (memory == IntPtr.Zero) return false;
                IntPtr pointer = GlobalLock(memory);
                if (pointer == IntPtr.Zero) { GlobalFree(memory); return false; }
                try { Marshal.Copy(value.ToCharArray(), 0, pointer, value.Length); Marshal.WriteInt16(pointer, value.Length * 2, 0); }
                finally { GlobalUnlock(memory); }
                if (SetClipboardData(CF_UNICODETEXT, memory) == IntPtr.Zero) { GlobalFree(memory); return false; }
                return true;
            }
            finally { CloseClipboard(); }
        }
        return false;
    }

    // 拖拽后确认“到底选中了没有”：发一次 Ctrl+C，看剪贴板是否出现文字。
    // 产品取不到词时，先要排除测试本身压根没选中内容。
    static string lastProbeText;
    static bool ProbeSelection()
    {
        WriteClipboard("copick-sentinel-selection-probe");
        SendInput(1, new[] { Key(0x11, 0) }, Marshal.SizeOf(typeof(INPUT)));
        SendInput(1, new[] { Key(0x43, 0) }, Marshal.SizeOf(typeof(INPUT)));
        SendInput(1, new[] { Key(0x43, 2) }, Marshal.SizeOf(typeof(INPUT)));
        SendInput(1, new[] { Key(0x11, 2) }, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(300);
        string text = ReadClipboard();
        lastProbeText = text;
        return !string.IsNullOrEmpty(text) && text != "copick-sentinel-selection-probe";
    }

    // 剪贴板/探针文本和文档原文不可能逐字节相同：HTML 的标签和 <br> 不在复制结果里，
    // 换行会被规范化，拖选还可能截断在字符中间。所以剥标签、忽略空白，按包含关系比对。
    // 16 字符的门槛能排除页面上短标题（CopickCompat 只有 12 个字符）这类巧合。
    static bool FromDocument(string text, string documentText)
    {
        string squashed = Squash(text);
        string expected = Squash(documentText);
        return squashed.Length >= 16 && expected.IndexOf(squashed, StringComparison.Ordinal) >= 0;
    }

    // 点浮窗复制，读剪贴板，判断内容是否来自测试文档。
    // 返回 true 表示浮窗确实被点到了（不代表内容正确，内容看 fromDocument）。
    static bool CopyFromPopup(IntPtr popup, IntPtr target, Dictionary<string, object> report,
                              string documentText, string clipboardFile, out bool fromDocument)
    {
        fromDocument = false;
        RECT bounds; GetWindowRect(popup, out bounds);
        report["popupBounds"] = bounds.Left + "," + bounds.Top + "," + (bounds.Right - bounds.Left) + "x" + (bounds.Bottom - bounds.Top);
        report["sourceFocusedBeforeClick"] = GetForegroundWindow() == target;
        var center = new POINT { X = (bounds.Left + bounds.Right) / 2, Y = (bounds.Top + bounds.Bottom) / 2 };
        SetCursorPos(center.X, center.Y);
        Thread.Sleep(100);
        // 先放一个哨兵：产品没写剪贴板时读回来的是它，而不是上一次残留的任意内容。
        string sentinel = "copick-sentinel-" + Guid.NewGuid().ToString("N");
        report["clipboardSentinelWritable"] = WriteClipboard(sentinel);
        report["clipboardSentinel"] = sentinel;
        SendInput(1, new[] { Mouse(2) }, Marshal.SizeOf(typeof(INPUT)));
        SendInput(1, new[] { Mouse(4) }, Marshal.SizeOf(typeof(INPUT)));
        // 产品在 worker 线程异步写剪贴板，而 OpenClipboard 只重试 250ms。
        // 这里不能边点边轮询：驱动每次打开剪贴板都会把 worker 挡在外面，
        // 测出来的是驱动的干扰，不是产品行为。静置后单次读取。
        var copyStart = DateTime.UtcNow;
        Thread.Sleep(1200);
        string text = ReadClipboard();
        report["clipboardLatencyMs"] = (int)(DateTime.UtcNow - copyStart).TotalMilliseconds;
        report["clipboardText"] = text;
        if (text != null && clipboardFile != null) System.IO.File.WriteAllText(clipboardFile, text, new UTF8Encoding(false));
        // 剪贴板文本和文档原文不可能逐字节相同：HTML 场景的标签和 <br> 不在复制
        // 结果里，换行被规范化，拖选还可能截断在字符中间。所以剥标签、忽略空白，
        // 再按包含关系比对。16 字符的门槛能排除页面上短标题（CopickCompat 只有
        // 12 个字符）这类巧合，又不会因为拖选短就误判。
        bool untouched = string.Equals(text, sentinel, StringComparison.Ordinal);
        fromDocument = !untouched && FromDocument(text, documentText);
        report["clipboardUntouched"] = untouched;
        report["clipboardFromDocument"] = fromDocument;
        // 复制成功后浮窗还要 650ms 才过期隐藏，等待而不是立刻判定。
        var hideDeadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < hideDeadline && IsWindowVisible(popup)) Thread.Sleep(100);
        report["popupHiddenAfterClick"] = !IsWindowVisible(popup);
        return true;
    }

    // 用 UIA TextPattern 读当前选区，作为“UIA 到底能不能读”的独立判据。
    static string ReadUiaSelection(IntPtr window)
    {
        try
        {
            var element = System.Windows.Automation.AutomationElement.FromHandle(window);
            if (element == null) return null;
            var found = element.FindFirst(System.Windows.Automation.TreeScope.Descendants,
                new System.Windows.Automation.PropertyCondition(
                    System.Windows.Automation.AutomationElement.ControlTypeProperty,
                    System.Windows.Automation.ControlType.Document));
            object pattern;
            if (found == null || !found.TryGetCurrentPattern(System.Windows.Automation.TextPattern.Pattern, out pattern)) return null;
            var ranges = ((System.Windows.Automation.TextPattern)pattern).GetSelection();
            if (ranges == null || ranges.Length == 0) return "empty";
            string text = ranges[0].GetText(-1);
            return text == null ? "null" : text.Length > 60 ? text.Substring(0, 60) : text;
        }
        catch (Exception ex) { return "error:" + ex.GetType().Name; }
    }

    // 用 UIA 找正文控件（Document 或 Edit）的屏幕外框。找不到就返回 false，
    // 调用方回落到按窗口比例取点。
    static bool TryFindContentRect(IntPtr window, out int left, out int top, out int right)
    {
        left = top = right = 0;
        try
        {
            var element = System.Windows.Automation.AutomationElement.FromHandle(window);
            if (element == null) return false;
            var condition = new System.Windows.Automation.OrCondition(
                new System.Windows.Automation.PropertyCondition(
                    System.Windows.Automation.AutomationElement.ControlTypeProperty,
                    System.Windows.Automation.ControlType.Document),
                new System.Windows.Automation.PropertyCondition(
                    System.Windows.Automation.AutomationElement.ControlTypeProperty,
                    System.Windows.Automation.ControlType.Edit));
            var found = element.FindFirst(System.Windows.Automation.TreeScope.Descendants, condition);
            if (found == null) return false;
            var bounds = found.Current.BoundingRectangle;
            if (bounds.Width < 200 || bounds.Height < 100) return false;
            RECT client; GetClientRect(window, out client);
            var origin = new POINT { X = 0, Y = 0 };
            ClientToScreen(window, ref origin);
            // 转成客户区坐标，和拖拽点用同一套坐标系。
            left = (int)bounds.Left - origin.X;
            top = (int)bounds.Top - origin.Y;
            right = (int)bounds.Right - origin.X;
            return left >= 0 && right <= client.Right && right > left;
        }
        catch { return false; }
    }

    // 去掉 HTML 标签（含 <br>）与所有空白，只留下可见字符。
    // 比对的是“这段文字确实来自这份文档”，不是逐字节相等。
    static string Squash(string value)
    {
        if (value == null) return "";
        var builder = new StringBuilder(value.Length);
        bool inTag = false;
        foreach (char c in value)
        {
            if (c == '<') { inTag = true; continue; }
            if (c == '>') { inTag = false; continue; }
            if (inTag) continue;
            if (char.IsWhiteSpace(c)) continue;
            builder.Append(c);
        }
        return builder.ToString();
    }

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length != 5 && args.Length != 6) { Console.WriteLine("usage: <report> <prototypePid> <title> <popup|none> <clipboardFile> [documentFile]"); return 2; }
        output = args[0];
        prototypePid = int.Parse(args[1]);
        title = args[2];
        string expect = args[3];
        string clipboardFile = args[4];
        documentFile = args.Length == 6 ? args[5] : null;
        var report = new Dictionary<string, object>();
        bool passed = false;
        string error = null;
        try { SetProcessDPIAware(); } catch { }
        // 测试文档被被测应用独占地打开（Word 就是这样），只能提前读。
        string documentText = null;
        if (documentFile != null)
        {
            try { documentText = System.IO.File.ReadAllText(documentFile); }
            catch (Exception ex) { documentText = null; report["documentReadError"] = ex.GetType().Name; }
        }
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
            // 正文在哪不能猜：Word 打开导航窗格时页面区从客户区 38% 处才开始，
            // 固定坐标会落在窗格里，选中为空。先问 UIA 正文控件的位置。
            // Word/VS Code 启动慢，文档控件要几秒才出现在无障碍树里，所以重试。
            int contentLeft = 0, contentTop = 0, contentRight = 0;
            bool located = false;
            for (int attempt = 0; attempt < 15 && !located; ++attempt)
            {
                located = TryFindContentRect(target, out contentLeft, out contentTop, out contentRight);
                if (!located) Thread.Sleep(400);
            }
            report["contentLocated"] = located;
            if (!located) { contentLeft = 24; contentTop = 0; contentRight = client.Right; }
            report["contentRect"] = contentLeft + "," + contentTop + "," + contentRight;
            // 正文位置因应用而异：记事本在顶部，Word 打开导航窗格时正文从客户区 46%
            // 处才开始，VS Code 有行号栏。所以横向纵向都扫一遍，而不是只调纵向。
            var candidates = new List<POINT>();
            foreach (int delta in new[] { 20, 60, 100, 150, 220 }) candidates.Add(new POINT { X = -1, Y = contentTop + delta });
            foreach (double fraction in new[] { 0.3, 0.45, 0.6, 0.75 }) candidates.Add(new POINT { X = -1, Y = (int)(client.Bottom * fraction) });
            IntPtr popup = IntPtr.Zero;
            int attempts = 0;
            bool selectionMade = false;
            bool copied = false;
            bool fromDocument = false;
            foreach (var candidate in candidates)
            {
                int top = candidate.Y;
                if (top > client.Bottom - 20) continue;
                // UIA 已经给出正文位置时横向不用再扫。
                foreach (double xFraction in (located ? new[] { 0.12 } : new[] { 0.3, 0.45, 0.6 }))
                {
                    // 从正文控件内部起拖，避开导航窗格/行号栏这类侧边区域。
                    int left = located ? Math.Max(24, contentLeft + 40) : Math.Max(24, (int)(client.Right * xFraction));
                    var from = new POINT { X = left, Y = top };
                    // 拖到窗口右边缘会压在滚动条上；固定 320px 落在正文里。
                    // 截在字符中间没关系，下面的包含匹配容忍截断。
                    var to = new POINT { X = Math.Min(contentRight - 60, left + 320), Y = top + 24 };
                    ClientToScreen(target, ref from);
                    ClientToScreen(target, ref to);
                    attempts++;
                    if (GetForegroundWindow() != target) { SetForegroundWindow(target); Thread.Sleep(300); }
                    // 上一次拖拽可能点进了 Word 的后台视图（另存为/信息等），
                    // 那之后所有坐标都落在后台页面上。每轮先按 Esc 退回文档。
                    SendInput(1, new[] { Key(0x1B, 0) }, Marshal.SizeOf(typeof(INPUT)));
                    SendInput(1, new[] { Key(0x1B, 2) }, Marshal.SizeOf(typeof(INPUT)));
                    Thread.Sleep(250);
                    popup = IntPtr.Zero;
                    Drag(from, to);
                    // 浮窗在拖拽结束后几百毫秒内就出现；等太久只会拖长整个矩阵。
                    var deadline = DateTime.UtcNow.AddSeconds(1.2);
                    while (DateTime.UtcNow < deadline && popup == IntPtr.Zero)
                    {
                        popup = FindPopup();
                        if (popup == IntPtr.Zero) Thread.Sleep(150);
                    }
                    if (expect == "none") break;
                    if (popup == IntPtr.Zero)
                    {
                        // 没等到浮窗时先确认这次拖拽到底选中了没有。选中了却没浮窗是
                        // 产品的问题，值得立刻停下记录；没选中就继续试下一个坐标。
                        // 选中了却取不到词才算产品漏路径；选中的是标签栏之类的别处文字，
                        // 那只是坐标不对，继续换下一个。
                        if (ProbeSelection() && FromDocument(lastProbeText, documentText))
                        {
                            selectionMade = true;
                            report["selectionMadeWithoutPopup"] = true;
                            report["uiaSelection"] = ReadUiaSelection(target);
                            break;
                        }
                        continue;
                    }
                    // 浮窗出现不代表选对了地方：地址栏、工具栏选中文字同样会弹窗。
                    // 只有剪贴板内容确实来自测试文档才算成功，否则关掉浮窗换个坐标重试。
                    copied = CopyFromPopup(popup, target, report, documentText, clipboardFile, out fromDocument);
                    if (fromDocument) break;
                    // CopyFromPopup 已经等到浮窗隐藏，这里直接换下一个坐标。
                }
                if (copied && fromDocument) break;
                if (selectionMade || expect == "none") break;
            }
            report["dragAttempts"] = attempts;
            // 全部坐标都没出浮窗时，记录最后一次探针的结果。
            if (!copied && expect != "none" && !selectionMade)
            {
                string probe = lastProbeText;
                report["selectionProbe"] = probe == null ? null : probe.Length > 60 ? probe.Substring(0, 60) : probe;
            }
            report["popupShown"] = copied;
            if (expect == "none")
            {
                passed = !copied;
                report["expectation"] = "no popup for a blocked program";
            }
            else
            {
                if (!copied) throw new InvalidOperationException("拖选后没有出现可用的浮窗");
                passed = fromDocument && (bool)report["popupHiddenAfterClick"];
                report["expectation"] = "popup shown, click copies the selection, popup hides";
            }
        }
        catch (Exception ex)
        {
            error = ex.GetType().Name + ": " + ex.Message;
            // 拖选失败时截一张窗口图：坐标错了和文档没加载，光看日志分不出来。
            try
            {
                IntPtr target = FindTarget();
                if (target != IntPtr.Zero)
                {
                    RECT rect; GetWindowRect(target, out rect);
                    using (var bitmap = new System.Drawing.Bitmap(Math.Max(1, rect.Right - rect.Left), Math.Max(1, rect.Bottom - rect.Top)))
                    using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
                    {
                        graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, bitmap.Size);
                        bitmap.Save(System.IO.Path.ChangeExtension(output, ".png"), System.Drawing.Imaging.ImageFormat.Png);
                    }
                }
            }
            catch { }
        }
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
