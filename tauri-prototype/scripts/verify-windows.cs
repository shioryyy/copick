using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Automation;

// 在独立交互桌面进程中生成真实鼠标输入，不注入取词结果。
class CopickFixture : Form {
    const string Expected = "CopickPrototype";
    const string Sentinel = "copick-verification-sentinel";
    string output, mode;
    int appPid, ticks;
    TextBoxBase text;
    Control source;
    Form alternate;
    Process foregroundHelper;
    IntPtr backgroundForeground, mouseHook;
    MouseHookProc mouseHookProc;
    int backgroundDowns, backgroundUps;
    IntPtr popup;
    Rectangle popupBounds;
    // 用户剪贴板备份只在 GuardianSession 指向的外部进程中；本进程不保留副本，
    // 因此 fixture 被强杀不会带走原始内容。
    GuardianSession guardian;
    bool focusBefore, finishing;
    uint sentinelSequence;
    long productLogOffset;
    DateTime runStarted;
    string phase = "select";
    System.Windows.Forms.Timer timer;
    DateTime started;
    Dictionary<string, object> report = new Dictionary<string, object>();
    // 复制窗口只有约 3.5 秒，期间谁改过剪贴板必须能事后还原。这里按时间
    // 记录序列号与文本摘要，不保存正文，失败时写进报告。
    readonly List<string> clipboardTimeline = new List<string>();
    uint lastTimelineSequence;
    // 必须区分“剪贴板是空的”“被别的进程占着”“内容不同”，否则三种完全
    // 不同的故障会都表现成“不匹配”。
    string TimelineText() {
        for (int attempt = 0; attempt < 4; attempt++) {
            try {
                if (!Clipboard.ContainsText()) {
                    string[] names = Clipboard.GetDataObject() == null ? new string[0] : Clipboard.GetDataObject().GetFormats();
                    return names.Length == 0 ? "empty" : "no-text[" + string.Join("+", names) + "]";
                }
                string value = Clipboard.GetText();
                if (value == Expected) return "expected";
                if (value == Sentinel) return "sentinel";
                return "len=" + value.Length;
            } catch (Exception error) {
                // 产品刚写入时 OpenClipboard 会短暂失败；重试而不是立刻记成异常。
                if (attempt == 3) return "<" + error.GetType().Name + ":" + error.Message.Trim() + ">";
                Thread.Sleep(30);
            }
        }
        return "<unknown>";
    }
    void RecordClipboard(string where) {
        uint sequence = ClipboardGuardian.CurrentSequence();
        if (sequence == lastTimelineSequence) return;
        lastTimelineSequence = sequence;
        clipboardTimeline.Add(((int)(DateTime.UtcNow - runStarted).TotalMilliseconds).ToString(
            System.Globalization.CultureInfo.InvariantCulture) + "ms " + where + " seq=" + sequence + " text=" + TimelineText());
    }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
    [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT point; public uint data, flags, time; public UIntPtr extra; }
    delegate IntPtr MouseHookProc(int code, IntPtr message, IntPtr data);
    delegate bool EnumProc(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, MouseHookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT bounds);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, System.Text.StringBuilder value, int size, out int needed);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    void RequireInteractiveDesktop() {
        IntPtr desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) throw new InvalidOperationException("无法读取输入桌面；不发送输入");
        try {
            var name = new System.Text.StringBuilder(256); int needed;
            if (!GetUserObjectInformation(desktop, 2, name, 512, out needed)) throw new InvalidOperationException("无法读取输入桌面名称");
            report["inputDesktop"] = name.ToString();
            if (name.ToString() != "Default") throw new InvalidOperationException("输入桌面不是 Default；不发送输入");
        } finally { CloseDesktop(desktop); }
    }
    // 读取产品日志在本轮开始时之后的部分；只有产品自己报告复制成功，
    // 才允许向守护进程声明这份剪贴板版本属于它。
    bool ProductCopyConfirmed() {
        string path = Environment.GetEnvironmentVariable("COPICK_PROTOTYPE_LOG");
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return false;
        byte[] data = File.ReadAllBytes(path);
        if (data.Length < productLogOffset) return false;
        string text = System.Text.Encoding.UTF8.GetString(data, (int)productLogOffset, data.Length - (int)productLogOffset);
        return text.Contains("COPICK_COPY_OK request=");
    }
    bool WaitForProductCopy(int milliseconds) {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        do {
            if (ProductCopyConfirmed()) return true;
            Thread.Sleep(50);
        } while (DateTime.UtcNow < deadline);
        return ProductCopyConfirmed();
    }
    // 产品复制成功后，让守护进程用序列号 + 全部格式 + 所有者 PID 核验版本归属。
    bool ClaimProductCopy() {
        if (guardian == null) return false;
        if (!WaitForProductCopy(3000)) { report["productCopyConfirmed"] = false; return false; }
        report["productCopyConfirmed"] = true;
        bool accepted = guardian.Claim(Expected, true, appPid);
        report["guardianClaimAccepted"] = accepted;
        return accepted;
    }

    static INPUT Mouse(uint flags) { return new INPUT { type = 0, data = new UNION { mouse = new MOUSEINPUT { flags = flags } } }; }
    static void MoveTo(Point point) {
        Rectangle desktop = SystemInformation.VirtualScreen;
        INPUT input = Mouse(0x8000 | 0x4000 | 0x0001);
        input.data.mouse.dx = (int)((long)(point.X - desktop.Left) * 65535 / (desktop.Width - 1));
        input.data.mouse.dy = (int)((long)(point.Y - desktop.Top) * 65535 / (desktop.Height - 1));
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("鼠标移动输入失败");
    }
    static void Down() { SendInput(1, new INPUT[] { Mouse(2) }, Marshal.SizeOf(typeof(INPUT))); }
    static void Up() { SendInput(1, new INPUT[] { Mouse(4) }, Marshal.SizeOf(typeof(INPUT))); }
    static void MouseClickAt(Point p, int count) {
        SetCursorPos(p.X, p.Y);
        // 让窗口先处理 WM_SETCURSOR：产品在自动取词前用鼠标指针图标判断是否可能
        // 位于文本上，紧接着点击可能仍读到箭头指针，导致回退被跳过。
        Thread.Sleep(120);
        for (int i = 0; i < count; i++) { Down(); Thread.Sleep(35); Up(); Thread.Sleep(55); }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string path);
    class NativeRichTextBox : RichTextBox {
        public string ProviderOutput, ProviderMode;
        public bool ProviderArmed;
        int providerBlocked;
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x003d && ProviderArmed && SelectionLength > 0 && Interlocked.CompareExchange(ref providerBlocked, 1, 0) == 0) {
                File.WriteAllText(Path.Combine(ProviderOutput, "provider-entered.txt"), DateTime.UtcNow.ToString("O"));
                if (ProviderMode == "blocked-exit") {
                    DateTime deadline = DateTime.UtcNow.AddSeconds(12);
                    while (!File.Exists(Path.Combine(ProviderOutput, "provider-release.txt")) && DateTime.UtcNow < deadline) Thread.Sleep(20);
                } else Thread.Sleep(6000);
                File.WriteAllText(Path.Combine(ProviderOutput, "provider-returned.txt"), DateTime.UtcNow.ToString("O"));
            }
            // This fixture must permit the activation click to start a selection.
            // RichEdit's default background activation otherwise consumes that click.
            if (message.Msg == 0x0021) { message.Result = (IntPtr)1; return; }
            base.WndProc(ref message);
        }
        protected override CreateParams CreateParams {
            get { LoadLibrary("msftedit.dll"); var parameters = base.CreateParams; parameters.ClassName = "RICHEDIT50W"; return parameters; }
        }
    }
    class ClipboardOnlyControl : Control {
        public bool Selected;
        public int CopyShortcutCount;
        public ClipboardOnlyControl() { Cursor = Cursors.IBeam; SetStyle(ControlStyles.Selectable, true); TabStop = true; }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            e.Graphics.Clear(Color.White);
            if (Selected) e.Graphics.FillRectangle(Brushes.LightBlue, 18, 18, 230, 35);
            e.Graphics.DrawString(Expected, new Font("Segoe UI", 18), Brushes.Black, 18, 18);
        }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); Focus(); }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); Selected = true; Invalidate(); }
        protected override bool ProcessCmdKey(ref Message message, Keys keys) {
            if (Selected && (keys == (Keys.Control | Keys.C) || keys == (Keys.Control | Keys.Insert))) { CopyShortcutCount++; Clipboard.SetText(Expected); return true; }
            return base.ProcessCmdKey(ref message, keys);
        }
    }
    CopickFixture(string path, string scenario, int pid) {
        output = path; mode = scenario; appPid = pid;
        Directory.CreateDirectory(output);
        Text = "Copick Windows 验证用选区";
        StartPosition = FormStartPosition.Manual; Bounds = new Rectangle(180, 180, 600, 240);
        Font = new Font("Segoe UI", 18);
        if (mode == "fallback" || mode == "fallback-disabled") source = new ClipboardOnlyControl { Bounds = new Rectangle(20, 30, 540, 100) };
        else {
            text = new NativeRichTextBox();
            text.Text = Expected + ".\r\nselection verification"; text.Bounds = new Rectangle(20, 30, 540, 100); text.Multiline = true; text.HideSelection = false;
            source = text;
        }
        Controls.Add(source);
        Shown += delegate {
            string initialization = "clipboard guardian";
            try {
                RequireInteractiveDesktop();
                // 产品日志偏移必须在任何输入之前记录，避免把上一轮的复制回执
                // 当作本轮成功。
                string log = Environment.GetEnvironmentVariable("COPICK_PROTOTYPE_LOG");
                productLogOffset = !string.IsNullOrEmpty(log) && File.Exists(log) ? new FileInfo(log).Length : 0;
                report["productLogOffset"] = productLogOffset;
                guardian = GuardianSession.Start(Application.ExecutablePath, output);
                if (guardian == null) throw new InvalidOperationException("独立剪贴板守护进程未能建立完整备份");
                sentinelSequence = guardian.Sequence;
                report["guardianPid"] = guardian.GuardianPid;
                // 若本进程被 runner 强杀，verification.json 永远不会写出。
                // 这个文件让 runner 仍能确认恢复报告属于本次守护进程。
                File.WriteAllText(Path.Combine(output, "guardian-pid.txt"),
                    guardian.GuardianPid.ToString(System.Globalization.CultureInfo.InvariantCulture));
                report["clipboardBackupFormatCount"] = guardian.BackupFormatCount;
                report["clipboardBackupComplete"] = true;
                report["sentinelSequence"] = (long)sentinelSequence;
                runStarted = DateTime.UtcNow;
                initialization = "source activation"; Activate(); source.Focus();
                if (mode == "background-drag") {
                    // A stays foreground while the first and only drag starts in background B.
                    foregroundHelper = Process.Start(Application.ExecutablePath, "foreground-helper");
                    if (!foregroundHelper.WaitForInputIdle(3000)) throw new InvalidOperationException("前台 A 未就绪");
                    foregroundHelper.Refresh(); backgroundForeground = foregroundHelper.MainWindowHandle;
                    if (backgroundForeground == IntPtr.Zero || !SetForegroundWindow(backgroundForeground)) throw new InvalidOperationException("无法激活独立进程前台 A");
                    report["foregroundASeparateProcess"] = true;
                    mouseHookProc = ObserveBackgroundDrag;
                    mouseHook = SetWindowsHookEx(14, mouseHookProc, IntPtr.Zero, 0);
                    if (mouseHook == IntPtr.Zero) throw new InvalidOperationException("无法观察后台拖选鼠标事件");
                }
                started = DateTime.UtcNow;
                timer = new System.Windows.Forms.Timer { Interval = 100 }; timer.Tick += Tick; timer.Start();
            } catch (Exception error) { Finish(false, "初始化失败（" + initialization + "）：" + error.GetType().Name + ": " + error.Message); }
        };
    }
    bool ProviderScenario() { return mode == "slow-control" || mode == "slow-exit" || mode == "blocked-exit"; }
    void StartProviderController() {
        foreach (string marker in new string[] { "provider-entered.txt", "provider-returned.txt", "provider-release.txt", "controller-passed.txt", "provider-control.json" }) File.Delete(Path.Combine(output, marker));
        var nativeText = (NativeRichTextBox)text;
        nativeText.ProviderOutput = output; nativeText.ProviderMode = mode;
        new Thread(delegate() {
            var result = new Dictionary<string, object>(); bool passed = false;
            try {
                DateTime deadline = DateTime.UtcNow.AddSeconds(7);
                while (!File.Exists(Path.Combine(output, "provider-entered.txt")) && DateTime.UtcNow < deadline) Thread.Sleep(20);
                if (!File.Exists(Path.Combine(output, "provider-entered.txt"))) throw new InvalidOperationException("UIA provider dispatch 未被调用");
                result["providerEntered"] = true;
                var watch = Stopwatch.StartNew();
                Process app = Process.GetProcessById(appPid);
                if (mode == "slow-control") {
                    AutomationElement root = AutomationElement.FromHandle(app.MainWindowHandle);
                    AutomationElement pause = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "暂停监听"));
                    if (pause == null) throw new InvalidOperationException("找不到真实主 UI 暂停按钮");
                    ((InvokePattern)pause.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                    AutomationElement resume = null;
                    deadline = DateTime.UtcNow.AddSeconds(2);
                    do { resume = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "恢复监听")); if (resume == null) Thread.Sleep(30); } while (resume == null && DateTime.UtcNow < deadline);
                    if (resume == null) throw new InvalidOperationException("暂停 UI 未响应");
                    result["pauseAcknowledged"] = true;
                    ((InvokePattern)resume.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                    AutomationElement resumed = null;
                    deadline = DateTime.UtcNow.AddSeconds(2);
                    do { resumed = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "暂停监听")); if (resumed == null) Thread.Sleep(30); } while (resumed == null && DateTime.UtcNow < deadline);
                    if (resumed == null) throw new InvalidOperationException("恢复 UI 未响应");
                    result["resumeAcknowledged"] = true;
                } else {
                    // 关闭设置窗口只会隐藏到托盘，必须调用真实退出按钮并确认进程结束。
                    AutomationElement root = AutomationElement.FromHandle(app.MainWindowHandle);
                    AutomationElement quit = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "退出 Copick"));
                    if (quit == null) throw new InvalidOperationException("找不到设置页退出 Copick 按钮");
                    ((InvokePattern)quit.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                    if (!app.WaitForExit(2500)) throw new InvalidOperationException("点击退出 Copick 后进程未退出");
                    result["appExited"] = true;
                }
                result["controlMilliseconds"] = (int)watch.ElapsedMilliseconds;
                result["completedBeforeProviderReturned"] = !File.Exists(Path.Combine(output, "provider-returned.txt"));
                passed = (bool)result["completedBeforeProviderReturned"];
            } catch (Exception error) { result["error"] = error.ToString(); }
            finally {
                result["passed"] = passed;
                var rows = new List<string>(); foreach (var item in result) rows.Add(Json(item.Key) + ": " + Json(item.Value));
                File.WriteAllText(Path.Combine(output, "provider-control.json"), "{" + string.Join(",", rows) + "}", new System.Text.UTF8Encoding(false));
                if (passed) File.WriteAllText(Path.Combine(output, "controller-passed.txt"), "passed");
                if (mode == "blocked-exit") File.WriteAllText(Path.Combine(output, "provider-release.txt"), "release after control check");
            }
        }) { IsBackground = true }.Start();
    }
    // 只有序列号仍停在守护进程写入的那一版、且内容确实是 sentinel 时，
    // 才能说本轮没有改动用户剪贴板。
    bool SentinelIntact() {
        return ClipboardGuardian.CurrentSequence() == sentinelSequence &&
            Clipboard.ContainsText() && Clipboard.GetText() == Sentinel;
    }
    // 回退场景由产品自己备份并重写剪贴板，序列号必然前进，不能作为“未改动”的判据；
    // 此时以文本内容判定恢复完成，格式完整性与最终写回由守护进程报告独立核验。
    bool SentinelTextIntact() { return Clipboard.ContainsText() && Clipboard.GetText() == Sentinel; }
    bool SourceFocused() { return GetForegroundWindow() == Handle; }
    IntPtr ObserveBackgroundDrag(int code, IntPtr message, IntPtr data) {
        if (code == 0 && phase == "popup") {
            var mouse = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(MSLLHOOKSTRUCT));
            if (message == (IntPtr)0x0201) {
                backgroundDowns++;
                report["foregroundAAtDown"] = GetForegroundWindow() == backgroundForeground;
                report["hitSourceBAtDown"] = GetAncestor(WindowFromPoint(mouse.point), 2) == Handle;
            } else if (message == (IntPtr)0x0202) {
                backgroundUps++;
                report["foregroundBAtUp"] = SourceFocused();
            }
        }
        return CallNextHookEx(mouseHook, code, message, data);
    }
    bool BackgroundDragVerified() {
        return backgroundDowns == 1 && backgroundUps == 1 && report.ContainsKey("foregroundAAtDown") &&
            (bool)report["foregroundAAtDown"] && (bool)report["hitSourceBAtDown"] && (bool)report["foregroundBAtUp"];
    }
    bool FindPopup() {
        IntPtr found = IntPtr.Zero; Rectangle rectangle = Rectangle.Empty;
        EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            RECT bounds;
            if (pid == appPid && IsWindowVisible(hwnd) && GetWindowRect(hwnd, out bounds)) {
                int w = bounds.Right - bounds.Left, h = bounds.Bottom - bounds.Top;
                if (w >= 80 && w <= 300 && h >= 35 && h <= 150) { found = hwnd; rectangle = Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom); return false; }
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return false;
        popup = found; popupBounds = rectangle; return true;
    }
    void Tick(object sender, EventArgs args) {
        try {
            if ((DateTime.UtcNow - runStarted).TotalSeconds > 18) { Finish(false, "验证超时；恢复测试前剪贴板"); return; }
            if (phase == "select") {
                if ((DateTime.UtcNow - started).TotalMilliseconds < 700) return;
                Point from = source.PointToScreen(mode == "fallback" || mode == "fallback-disabled" ? new Point(50, 35) : new Point(8, 16));
                if (mode == "background-drag") {
                    bool ready = GetForegroundWindow() == backgroundForeground && !SourceFocused();
                    report["sourceBackgroundBeforeDrag"] = ready;
                    if (!ready) { Finish(false, "拖选前 A 未保持前台或 B 已激活"); return; }
                }
                if (ProviderScenario()) {
                    StartProviderController();
                    ((NativeRichTextBox)text).ProviderArmed = true;
                }
                if (mode == "drag" || mode == "background-drag") {
                    Point first = text.GetPositionFromCharIndex(0);
                    Point last = text.GetPositionFromCharIndex(Expected.Length);
                    from = text.PointToScreen(new Point(first.X + 1, first.Y + 10));
                    Point to = text.PointToScreen(new Point(last.X, first.Y + 10));
                    if (mode == "background-drag") {
                        report["dragFromX"] = from.X; report["dragFromY"] = from.Y;
                        report["dragToX"] = to.X; report["dragToY"] = to.Y;
                        report["sourceClientWidth"] = text.ClientSize.Width; report["sourceClientHeight"] = text.ClientSize.Height;
                        text.MouseDown += delegate(object s, MouseEventArgs e) { report["sourceReceivedDown"] = true; report["sourceDownX"] = e.X; report["sourceDownY"] = e.Y; };
                        text.MouseUp += delegate(object s, MouseEventArgs e) { report["sourceReceivedUp"] = true; report["sourceUpX"] = e.X; report["sourceUpY"] = e.Y; report["selectionAtUp"] = text.SelectionLength; };
                        text.MouseMove += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { report["sourceReceivedDragMove"] = true; report["selectionDuringDrag"] = text.SelectionLength; report["sourceCapturedDuringDrag"] = text.Capture; } };
                        text.GotFocus += delegate { report["sourceGotFocus"] = true; };
                    }
                    new Thread(delegate() {
                        MoveTo(from); Down(); Thread.Sleep(80);
                        for (int i = 1; i <= 15; i++) { MoveTo(new Point(from.X + (to.X - from.X) * i / 15, from.Y)); Thread.Sleep(25); }
                        Up();
                    }) { IsBackground = true }.Start();
                } else MouseClickAt(from, 2);
                phase = ProviderScenario() ? "provider" : "popup"; ticks = 0;
            } else if (phase == "provider") {
                if (!File.Exists(Path.Combine(output, "provider-returned.txt")) || !File.Exists(Path.Combine(output, "provider-control.json"))) {
                    if ((DateTime.UtcNow - started).TotalSeconds > 14) { Finish(false, "未完成真实 provider 等待验证"); }
                    return;
                }
                if (++ticks < 12) return;
                bool control = File.Exists(Path.Combine(output, "controller-passed.txt"));
                bool hidden = !FindPopup();
                bool unchanged = SentinelIntact();
                report["providerDispatchBlocked"] = true; report["providerReturned"] = true;
                report["controlCompletedBeforeReturn"] = control; report["popupHidden"] = hidden; report["clipboardUnchanged"] = unchanged;
                Finish(control && hidden && unchanged, "真实 WM_GETOBJECT provider-dispatch 等待；拒绝迟到结果");
            } else if (phase == "popup") {
                if (mode == "fallback-disabled") {
                    bool shown = FindPopup();
                    if (shown) { Finish(false, "回退关闭却出现浮窗"); return; }
                    if (++ticks > 50) {
                        bool unchanged = SentinelIntact();
                        report["popupHidden"] = true;
                        report["clipboardUnchanged"] = unchanged;
                        report["sourceFocused"] = SourceFocused();
                        var control = (ClipboardOnlyControl)source;
                        report["selectionPreserved"] = control.Selected;
                        report["copyShortcutCount"] = control.CopyShortcutCount;
                        Finish(unchanged && SourceFocused() && control.Selected && control.CopyShortcutCount == 0, "回退关闭，无快捷键副作用");
                    }
                    return;
                }
                if (!FindPopup()) {
                    if (++ticks > 50) {
                        report["sourceFocused"] = SourceFocused();
                        report["selectionLength"] = text == null ? 0 : text.SelectionLength;
                        report["selectionMatches"] = text != null && text.SelectedText == Expected;
                        // 记录合成快捷键次数，用来区分「回退执行了但没取到词」和「回退根本没执行」。
                        report["copyShortcutCount"] = ((ClipboardOnlyControl)source).CopyShortcutCount;
                        Finish(false, "未发现复制浮窗");
                    }
                    return;
                }
                if (mode == "background-drag") {
                    if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
                    if (!BackgroundDragVerified()) { Finish(false, "未形成从前台 A 到后台 B 的单次真实拖选"); return; }
                }
                focusBefore = SourceFocused();
                RecordClipboard("before_click");
                report["popupShown"] = true; report["focusBeforeClick"] = focusBefore;
                report["clipboardRestoredBeforeClick"] = mode == "fallback" ? SentinelTextIntact() : SentinelIntact();
                if (mode == "fallback") report["clipboardSequenceBumped"] = ClipboardGuardian.CurrentSequence() != sentinelSequence;
                report["popupX"] = popupBounds.X; report["popupY"] = popupBounds.Y;
                report["popupWidth"] = popupBounds.Width; report["popupHeight"] = popupBounds.Height;
                using (Bitmap shot = new Bitmap(popupBounds.Width, popupBounds.Height)) {
                    using (Graphics graphics = Graphics.FromImage(shot)) graphics.CopyFromScreen(popupBounds.Location, Point.Empty, popupBounds.Size);
                    shot.Save(Path.Combine(output, "popup.png"));
                }
                if (mode == "switch" || mode == "samepid-switch") {
                    if (mode == "samepid-switch") {
                        alternate = new Form { Text = "Copick 同进程另一窗口", Bounds = new Rectangle(850, 180, 500, 240), StartPosition = FormStartPosition.Manual };
                        alternate.Show();
                        alternate.Activate();
                        SetForegroundWindow(alternate.Handle);
                    } else {
                        foreach (Process app in Process.GetProcessesByName("copick-tauri-prototype")) if (app.Id == appPid) SetForegroundWindow(app.MainWindowHandle);
                    }
                    bool changed = !SourceFocused();
                    report["foregroundChanged"] = changed;
                    if (mode == "samepid-switch") {
                        uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                        bool samePid = pid == Process.GetCurrentProcess().Id;
                        report["sameSourcePid"] = samePid;
                        changed = changed && samePid && GetForegroundWindow() == alternate.Handle;
                    }
                    if (!changed) { Finish(false, "未能切换目标前台窗口"); return; }
                } else if (mode != "expiry") MouseClickAt(new Point(popupBounds.X + popupBounds.Width / 2, popupBounds.Y + popupBounds.Height / 2), 1);
                phase = "result"; started = DateTime.UtcNow;
            } else {
                double elapsed = (DateTime.UtcNow - started).TotalMilliseconds;
                if (mode == "expiry" || mode == "switch" || mode == "samepid-switch") {
                    if (elapsed < (mode == "expiry" ? 8200 : 800)) return;
                    bool hidden = !IsWindowVisible(popup);
                    bool unchanged = SentinelIntact();
                    report["popupHidden"] = hidden; report["clipboardUnchanged"] = unchanged;
                    Finish(hidden && unchanged, "选区失效验证"); return;
                }
                if (Clipboard.ContainsText() && Clipboard.GetText() == Expected) {
                    bool focus = SourceFocused(); bool selection = text == null ? ((ClipboardOnlyControl)source).Selected : text.SelectedText == Expected;
                    report["clipboardMatches"] = true; report["focusAfterClick"] = focus; report["selectionPreserved"] = selection;
                    // 文本匹配不等于产品写入：必须再有产品成功回执，并由守护进程
                    // 核验序列号、全部格式与所有者 PID 后才能声明这一版属于产品。
                    bool claimed = ClaimProductCopy();
                    report["copyVersionClaimed"] = claimed;
                    Finish(claimed && focusBefore && focus && selection && (bool)report["clipboardRestoredBeforeClick"],
                        claimed ? "真实鼠标点击复制完成" : "剪贴板文本匹配但版本归属未获确认");
                } else {
                    RecordClipboard("after_click");
                }
                if (elapsed > 3500) {
                    report["focusAfterClick"] = SourceFocused();
                    report["selectionPreserved"] = text == null ? ((ClipboardOnlyControl)source).Selected : text.SelectedText == Expected;
                    report["selectionLength"] = text == null ? Expected.Length : text.SelectionLength;
                    report["clipboardLength"] = Clipboard.ContainsText() ? Clipboard.GetText().Length : 0;
                    report["clipboardMatchesAfterTrim"] = Clipboard.ContainsText() && Clipboard.GetText().Trim() == Expected;
                    Finish(false, "点击后剪贴板不匹配");
                }
            }
        } catch (Exception error) { Finish(false, error.GetType().Name + ": " + error.Message); }
    }
    static string Json(object value) {
        if (value == null) return "null";
        if (value is bool) return (bool)value ? "true" : "false";
        if (value is int) return value.ToString();
        if (value is long) return value.ToString();
        // 嵌套对象来自守护进程报告，需要保持结构而不是打印类型名。
        var list = value as List<string>;
        if (list != null) {
            var items = new List<string>();
            foreach (var item in list) items.Add(Json(item));
            return "[" + string.Join(",", items) + "]";
        }
        var nested = value as Dictionary<string, object>;
        if (nested != null) {
            var items = new List<string>();
            foreach (var item in nested) items.Add(Json(item.Key) + ": " + Json(item.Value));
            return "{" + string.Join(",", items) + "}";
        }
        return "\"" + value.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
    }
    void Finish(bool passed, string result) {
        if (finishing) return;
        finishing = true;
        if (timer != null) timer.Stop();
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        if (mode == "background-drag") {
            report["dragDownCount"] = backgroundDowns; report["dragUpCount"] = backgroundUps;
            report["backgroundDragVerified"] = BackgroundDragVerified();
            passed = passed && BackgroundDragVerified();
        }
        if (foregroundHelper != null && !foregroundHelper.HasExited) { foregroundHelper.CloseMainWindow(); if (!foregroundHelper.WaitForExit(1000)) foregroundHelper.Kill(); }
        // 恢复由外部守护进程完成：本进程死亡也不会丢失备份。它只在版本归属
        // 经序列号、全部格式和所有者 PID 核验通过后才写回。
        bool restored = false;
        if (guardian != null) {
            Dictionary<string, object> restoration = guardian.Finish();
            report["clipboardRestoration"] = restoration ?? new Dictionary<string, object>();
            restored = guardian.RestoredVerified;
            if (restoration != null) {
                report["clipboardRestoreOutcome"] = restoration.ContainsKey("outcome") ? restoration["outcome"] : null;
                report["guardianExitCode"] = guardian.ExitCode.HasValue ? (object)guardian.ExitCode.Value : null;
            }
        } else {
            report["clipboardRestoration"] = new Dictionary<string, object> { { "outcome", "notStarted" } };
        }
        RecordClipboard("finish");
        report["clipboardTimeline"] = clipboardTimeline;
        report["testClipboardRestored"] = restored;
        if (!restored) result = result + "；剪贴板恢复未确认";
        report["passed"] = passed && restored; report["scenario"] = mode; report["result"] = result; report["sourcePid"] = Process.GetCurrentProcess().Id;
        var rows = new List<string>(); foreach (var item in report) rows.Add("  " + Json(item.Key) + ": " + Json(item.Value));
        File.WriteAllText(Path.Combine(output, "verification.json"), "{\n" + string.Join(",\n", rows) + "\n}", new System.Text.UTF8Encoding(false));
        Environment.ExitCode = passed && restored ? 0 : 1; Close();
    }
    [STAThread] static void Main(string[] args) {
        // 守护进程与 fixture 是同一个可执行文件的不同模式，但它从不创建可见
        // 窗口，也不发送输入。
        if (args.Length == 4 && args[0] == "--clipboard-guardian") {
            Environment.ExitCode = ClipboardGuardian.Run(args[1], args[2], args[3]);
            return;
        }
        try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch { }
        Application.EnableVisualStyles();
        if (args.Length == 1 && args[0] == "foreground-helper") {
            Application.Run(new Form { Text = "Copick 拖选前台 A", Bounds = new Rectangle(820, 180, 420, 240), StartPosition = FormStartPosition.Manual });
            return;
        }
        Application.Run(new CopickFixture(args[0], args[1], int.Parse(args[2])));
    }
}
