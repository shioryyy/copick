using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// 用户剪贴板的备份只驻留本进程内存。GUI fixture 不保留第二份副本，因此
// fixture 被强杀不会丢失原始内容。
//
// Windows 提供两件 macOS 没有的东西，这里都用来做真实的版本所有权核验：
//   1. OpenClipboard 是排他锁，核验序列号/全部格式与恢复写入可以在同一个锁
//      内完成，其他进程无法插入。
//   2. GetClipboardOwner() 给出内容所有者的窗口，可以解析到写入进程 PID。
//      因此“同样的文本”也能区分是产品写的还是外部进程写的。
//
// 仍然无法覆盖：本进程自身被强杀、或某个进程永久占住剪贴板锁。
static class ClipboardGuardian {
    public const string Sentinel = "copick-verification-sentinel";
    public const string ProductText = "CopickPrototype";
    public const string SecondProductText = "SecondPrototype";
    const uint TextFormat = 13;
    const uint MoveableMemory = 2;
    const int MaxFormatBytes = 32 * 1024 * 1024;
    const long MaxTotalBytes = 64L * 1024 * 1024;
    const int MaxCommandBytes = 4096;

    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassEx(ref WNDCLASSEX windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName,
        uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PeekMessage(out MSG message, IntPtr window, uint filterMin, uint filterMax, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG message);
    [StructLayout(LayoutKind.Sequential)] struct MSG {
        public IntPtr Window; public uint Message; public IntPtr WParam, LParam; public uint Time; public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSEX {
        public uint Size, Style;
        public IntPtr WindowProc;
        public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background;
        public string MenuName, ClassName;
        public IntPtr SmallIcon;
    }
    delegate IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);

    public sealed class Snapshot {
        public uint Sequence;
        public long OwnerPid;
        public Dictionary<uint, byte[]> Formats;
    }

    enum RestoreResult { RestoredVerified, SkippedExternalChange, Indeterminate, Failed }

    // 剪贴板所有者窗口从不显示，也不使用延迟渲染，因此不需要消息循环。
    // 它只用于把内容归属到本进程，并在 OpenClipboard 时充当所有者句柄。
    //
    // 关键：OpenClipboard 的所有者只在“本线程第一次打开剪贴板”时确定，之后
    // 同一线程的调用不会更新它。因此窗口必须在任何剪贴板调用之前创建，且
    // 所有剪贴板操作都在同一个线程上执行。
    static IntPtr ownerWindow;
    static WindowProc ownerProc;
    static IntPtr CreateOwnerWindow() {
        if (ownerWindow != IntPtr.Zero) return ownerWindow;
        ownerProc = delegate(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam) {
            // 没有延迟渲染，但防御性地处理所有者相关消息。
            if (message == 0x0301 || message == 0x0305 || message == 0x0306) return IntPtr.Zero;
            return DefWindowProc(hwnd, message, wparam, lparam);
        };
        WNDCLASSEX windowClass = new WNDCLASSEX();
        windowClass.Size = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
        windowClass.WindowProc = Marshal.GetFunctionPointerForDelegate(ownerProc);
        windowClass.Instance = GetModuleHandle(null);
        windowClass.ClassName = "CopickClipboardGuardianOwner";
        if (RegisterClassEx(ref windowClass) == 0 && Marshal.GetLastWin32Error() != 1410)
            throw new InvalidOperationException("无法注册剪贴板所有者窗口类 Win32=" + Marshal.GetLastWin32Error());
        ownerWindow = CreateWindowEx(0x00000080, windowClass.ClassName, "Copick clipboard guardian",
            0x80000000, -32000, -32000, 1, 1, IntPtr.Zero, IntPtr.Zero, windowClass.Instance, IntPtr.Zero);
        if (ownerWindow == IntPtr.Zero) throw new InvalidOperationException("无法创建剪贴板所有者窗口 Win32=" + Marshal.GetLastWin32Error());
        return ownerWindow;
    }

    // 剪贴板所有者必须处理 WM_DESTROYCLIPBOARD。实测（2026-10-25，OMEN）：
    // 所有者进程不泵消息时，另一个进程的 EmptyClipboard 会阻塞整整 5001ms；
    // 泵消息时只需 13ms。守护进程持有 sentinel 所有权，如果它阻塞在读管道上
    // 不处理消息，产品自己的复制就会卡到超时并误报失败。
    public static void PumpMessages() {
        MSG message;
        while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
    }

    public static uint CurrentSequence() { return GetClipboardSequenceNumber(); }

    public static long WindowPid(IntPtr window) {
        if (window == IntPtr.Zero) return 0;
        uint pid;
        return GetWindowThreadProcessId(window, out pid) == 0 ? 0 : pid;
    }
    public static long ClipboardOwnerPid() { return WindowPid(GetClipboardOwner()); }
    public static long OpenClipboardPid() { return WindowPid(GetOpenClipboardWindow()); }

    // GDI、owner-display、图元文件和私有句柄格式无法逐字节复制。
    static bool Copyable(uint format) {
        return format != 2 && format != 3 && format != 9 && format != 14 &&
            !(format >= 0x80 && format <= 0x8e) && !(format >= 0x200 && format <= 0x2ff);
    }

    static bool OpenOwned(IntPtr owner, out string error) {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(2000);
        do {
            if (OpenClipboard(owner)) { error = null; return true; }
            Thread.Sleep(10);
        } while (DateTime.UtcNow < deadline);
        error = "无法打开剪贴板 Win32=" + Marshal.GetLastWin32Error() + " 占用进程=" + OpenClipboardPid();
        return false;
    }

    static bool ReadFormats(out Dictionary<uint, byte[]> formats, out string error) {
        formats = new Dictionary<uint, byte[]>();
        uint format = 0;
        long total = 0;
        while (true) {
            SetLastError(0);
            format = EnumClipboardFormats(format);
            if (format == 0) {
                if (Marshal.GetLastWin32Error() != 0) { error = "无法完整枚举剪贴板格式"; formats = null; return false; }
                error = null;
                return true;
            }
            if (!Copyable(format)) { error = "无法完整备份剪贴板句柄格式 " + format; formats = null; return false; }
            IntPtr handle = GetClipboardData(format);
            ulong size = handle == IntPtr.Zero ? 0 : GlobalSize(handle).ToUInt64();
            if (size == 0 || size > (ulong)MaxFormatBytes || total + (long)size > MaxTotalBytes) {
                error = "无法完整备份剪贴板格式 " + format + " 大小=" + size;
                formats = null;
                return false;
            }
            total += (long)size;
            IntPtr bytes = GlobalLock(handle);
            if (bytes == IntPtr.Zero) { error = "无法读取剪贴板格式 " + format; formats = null; return false; }
            try {
                byte[] value = new byte[(int)size];
                Marshal.Copy(bytes, value, 0, value.Length);
                formats.Add(format, value);
            } finally { GlobalUnlock(handle); }
        }
    }

    static IntPtr Allocate(byte[] bytes) {
        if (bytes == null || bytes.Length == 0) return IntPtr.Zero;
        IntPtr memory = GlobalAlloc(MoveableMemory, (UIntPtr)bytes.Length);
        if (memory == IntPtr.Zero) return IntPtr.Zero;
        IntPtr pointer = GlobalLock(memory);
        if (pointer == IntPtr.Zero) { GlobalFree(memory); return IntPtr.Zero; }
        try { Marshal.Copy(bytes, 0, pointer, bytes.Length); } finally { GlobalUnlock(memory); }
        return memory;
    }

    // 调用方必须持有剪贴板锁。成功后内存所有权移交系统。
    static bool WriteFormats(Dictionary<uint, byte[]> formats, out string error) {
        error = null;
        if (!EmptyClipboard()) { error = "无法清空剪贴板"; return false; }
        List<IntPtr> pending = new List<IntPtr>();
        try {
            foreach (KeyValuePair<uint, byte[]> item in formats) {
                IntPtr memory = Allocate(item.Value);
                if (memory == IntPtr.Zero) { error = "无法分配剪贴板格式 " + item.Key; return false; }
                pending.Add(memory);
                if (SetClipboardData(item.Key, memory) == IntPtr.Zero) { error = "无法写入剪贴板格式 " + item.Key; return false; }
                pending.Remove(memory);
            }
            return true;
        } finally { foreach (IntPtr memory in pending) GlobalFree(memory); }
    }

    // expected 覆盖在 actual 的前缀上即为匹配：GlobalAlloc 的块大小向上对齐，
    // 所以同一个内容在不同时间读回的尾部填充长度可能不同。比较始终在
    // OpenClipboard 锁内进行，不存在外部插入的可能。
    public static bool FormatsCover(Dictionary<uint, byte[]> actual, Dictionary<uint, byte[]> expected) {
        if (actual == null || expected == null || actual.Count != expected.Count) return false;
        foreach (KeyValuePair<uint, byte[]> item in expected) {
            byte[] value;
            if (!actual.TryGetValue(item.Key, out value)) return false;
            if (value == null || value.Length < item.Value.Length) return false;
            for (int index = 0; index < item.Value.Length; index++) if (value[index] != item.Value[index]) return false;
        }
        return true;
    }

    public static Dictionary<uint, byte[]> TextFormats(string text) {
        Dictionary<uint, byte[]> formats = new Dictionary<uint, byte[]>();
        formats.Add(TextFormat, Encoding.Unicode.GetBytes(text + "\0"));
        return formats;
    }

    // GlobalAlloc 返回的块大小（GlobalSize）是向上对齐的，可能大于请求长度。
    // 因此文本内容必须按 UTF-16 解码到第一个 NUL 再比较，不能逐字节比较长度；
    // 快照之间的比较用 FormatsCover（读回内容覆盖期望前缀）。
    public static string DecodeText(byte[] bytes) {
        if (bytes == null || bytes.Length < 2 || bytes.Length % 2 != 0) return null;
        StringBuilder builder = new StringBuilder(bytes.Length / 2);
        for (int index = 0; index + 1 < bytes.Length; index += 2) {
            char character = (char)(bytes[index] | (bytes[index + 1] << 8));
            if (character == '\0') return builder.ToString();
            builder.Append(character);
        }
        // 没有 NUL 终止符就不能认为这是一段完整的剪贴板文本。
        return null;
    }

    // 只比较 CF_UNICODETEXT 的内容。写入该格式后 Windows 会按需合成
    // CF_TEXT / CF_OEMTEXT / CF_LOCALE，所以不能要求“格式数恰好为 1”。
    public static bool TextEquals(Dictionary<uint, byte[]> formats, string text) {
        if (formats == null || text == null) return false;
        byte[] value;
        if (!formats.TryGetValue(TextFormat, out value)) return false;
        return string.Equals(DecodeText(value), text, StringComparison.Ordinal);
    }

    // 稳定比较：只比文本内容，不比所有者。
    //
    // 不能用 GetClipboardOwner 做“同一版本”判据：只要本进程打开并关闭剪贴板，
    // 所有者就会变成守护进程自己（实测 OpenClipboard/CloseClipboard 会推进
    // 序列号并接管所有权）。因此“是不是我们写的”只在 claim 时用所有者判定
    // 一次，之后的漂移检测只看内容是否被换成别的东西。
    public static bool SameTextVersion(Snapshot left, Snapshot right) {
        if (left == null || right == null) return false;
        byte[] a, b;
        if (!left.Formats.TryGetValue(TextFormat, out a) || !right.Formats.TryGetValue(TextFormat, out b)) {
            // 非文本内容退化为整份格式比较。
            return FormatsCover(left.Formats, right.Formats) && FormatsCover(right.Formats, left.Formats);
        }
        string textA = DecodeText(a), textB = DecodeText(b);
        if (textA != null || textB != null) return string.Equals(textA, textB, StringComparison.Ordinal);
        return FormatsCover(left.Formats, right.Formats) && FormatsCover(right.Formats, left.Formats);
    }

    static bool ProductTextFormats(Dictionary<uint, byte[]> formats) {
        return TextEquals(formats, ProductText) || TextEquals(formats, SecondProductText);
    }

    static Snapshot TakeSnapshot(out string error) {
        IntPtr owner = CreateOwnerWindow();
        if (!OpenOwned(owner, out error)) return null;
        try {
            uint sequence = GetClipboardSequenceNumber();
            Dictionary<uint, byte[]> formats;
            if (!ReadFormats(out formats, out error)) return null;
            if (GetClipboardSequenceNumber() != sequence) { error = "读取剪贴板期间内容发生变化"; return null; }
            Snapshot snapshot = new Snapshot();
            snapshot.Sequence = sequence;
            snapshot.OwnerPid = ClipboardOwnerPid();
            snapshot.Formats = formats;
            return snapshot;
        } finally { CloseClipboard(); }
    }

    public static Snapshot TakeSnapshot() { string error; return TakeSnapshot(out error); }

    // 对抗 harness 用：写入任意文本并读回核验，返回写入后的序列号。
    public static bool TryWriteText(string text, out uint sequence, out string error) {
        sequence = 0;
        IntPtr owner = CreateOwnerWindow();
        if (!OpenOwned(owner, out error)) return false;
        try {
            if (!WriteFormats(TextFormats(text), out error)) return false;
            Dictionary<uint, byte[]> written;
            if (!ReadFormats(out written, out error)) return false;
            if (!TextEquals(written, text)) { error = "写入后读回内容不一致"; return false; }
            sequence = GetClipboardSequenceNumber();
            return true;
        } finally { CloseClipboard(); }
    }

    // 对抗 harness 用：按整份快照写回并读回核验。
    public static bool RestoreSnapshot(Snapshot backup) {
        if (backup == null) return false;
        IntPtr owner = CreateOwnerWindow();
        string error;
        if (!OpenOwned(owner, out error)) return false;
        try {
            if (!WriteFormats(backup.Formats, out error)) return false;
            Dictionary<uint, byte[]> after;
            if (!ReadFormats(out after, out error)) return false;
            return FormatsCover(after, backup.Formats);
        } finally { CloseClipboard(); }
    }

    // 写入 sentinel 并读回核验。序列号必须在 CloseClipboard 之后重新读取：
    // 实测 EmptyClipboard +1、SetClipboardData +1、CloseClipboard 再 +3，
    // 关闭前读到的序列号永远对不上关闭后的真实值。
    static bool TryWriteSentinel(IntPtr owner, uint expected, out Snapshot confirmed, out string error) {
        confirmed = null;
        if (!OpenOwned(owner, out error)) return false;
        try {
            if (GetClipboardSequenceNumber() != expected) { error = "写 sentinel 前剪贴板已变化；保留用户内容"; return false; }
            if (!WriteFormats(TextFormats(Sentinel), out error)) return false;
            Dictionary<uint, byte[]> read;
            if (!ReadFormats(out read, out error)) return false;
            if (!TextEquals(read, Sentinel)) { error = "sentinel 读回内容不一致"; return false; }
            if (ClipboardOwnerPid() != Process.GetCurrentProcess().Id) { error = "sentinel 所有者不是守护进程"; return false; }
        } finally { CloseClipboard(); }
        // 关闭后重新取完整快照，得到稳定可比的版本。
        confirmed = TakeSnapshot(out error);
        if (confirmed == null) {
            if (error == null) error = "写 sentinel 后无法重新读取剪贴板";
            return false;
        }
        if (!TextEquals(confirmed.Formats, Sentinel)) {
            error = "写 sentinel 后内容被改变（格式数=" + confirmed.Formats.Count + " 所有者=" + confirmed.OwnerPid + "）";
            confirmed = null;
            return false;
        }
        if (confirmed.OwnerPid != Process.GetCurrentProcess().Id) {
            error = "写 sentinel 后所有者变为 " + confirmed.OwnerPid;
            confirmed = null;
            return false;
        }
        return true;
    }

    // 产品确认过成功复制之后，还要证明这份内容确实是产品写的。
    //
    // 归属判据只有“全部格式内容 + 所有者 PID”，没有序列号：在本平台读取
    // 剪贴板本身就会推进序列号（OpenClipboard/CloseClipboard 各算一次写），
    // 所以任何“序列号没变”的判据都恒为假。内容与所有者一起比较是充分的：
    // 同一 PID 的窗口不会写出两种不同的内容而不被察觉。
    static bool ClaimAccepted(Snapshot confirmed, string expected, long productPid, out Snapshot claimed) {
        claimed = null;
        if (confirmed == null || productPid <= 0) return false;
        string error;
        Snapshot current = TakeSnapshot(out error);
        if (current == null) return false;
        // 内容必须已经离开已确认版本（否则没有任何新写入可归属）。
        if (SameTextVersion(current, confirmed)) return false;
        if (!TextEquals(current.Formats, expected) || current.OwnerPid != productPid) return false;
        claimed = current;
        return true;
    }

    // 剪贴板是否仍停在我们最后确认过的那一版。被拒绝的 claim 本身不改变
    // 状态；只有内容确实已经偏离时才必须放弃恢复。
    static bool StillOwned(Snapshot confirmed) {
        if (confirmed == null) return false;
        string error;
        Snapshot current = TakeSnapshot(out error);
        return SameTextVersion(current, confirmed);
    }

    // 诊断用：把两份快照的差异写成可读文本，定位“内容已偏离”的具体格式。
    static string DescribeDifference(Snapshot actual, Snapshot expected) {
        if (actual == null) return "actual=null";
        if (expected == null) return "expected=null";
        List<string> parts = new List<string>();
        parts.Add("owner " + actual.OwnerPid + "/" + expected.OwnerPid);
        parts.Add("seq " + actual.Sequence + "/" + expected.Sequence);
        List<uint> keys = new List<uint>();
        foreach (uint key in actual.Formats.Keys) if (!keys.Contains(key)) keys.Add(key);
        foreach (uint key in expected.Formats.Keys) if (!keys.Contains(key)) keys.Add(key);
        keys.Sort();
        foreach (uint key in keys) {
            byte[] a, b;
            bool hasA = actual.Formats.TryGetValue(key, out a);
            bool hasB = expected.Formats.TryGetValue(key, out b);
            if (!hasA || !hasB) { parts.Add("format " + key + " present " + hasA + "/" + hasB); continue; }
            if (a.Length != b.Length) { parts.Add("format " + key + " size " + a.Length + "/" + b.Length); continue; }
            for (int index = 0; index < a.Length; index++)
                if (a[index] != b[index]) { parts.Add("format " + key + " differs at " + index); break; }
        }
        // 文本内容直接打印，便于区分“内容被改”与“格式长度变化”。
        string actualText = null, expectedText = null;
        byte[] actualBytes, expectedBytes;
        if (actual.Formats.TryGetValue(TextFormat, out actualBytes)) actualText = DecodeText(actualBytes);
        if (expected.Formats.TryGetValue(TextFormat, out expectedBytes)) expectedText = DecodeText(expectedBytes);
        parts.Add("text [" + (actualText ?? "?") + "]/[" + (expectedText ?? "?") + "]");
        return string.Join("; ", parts.ToArray());
    }

    // 全部核验与写入共享同一次 OpenClipboard 锁，其他进程无法插入。
    // 判据是“内容与所有者是否仍是我们最后确认的那一版”，不是序列号算术。
    static RestoreResult Restore(IntPtr owner, Snapshot backup, Snapshot confirmed,
        out uint ending, out long endingOwnerPid, out string detail) {
        ending = GetClipboardSequenceNumber();
        endingOwnerPid = ClipboardOwnerPid();
        detail = null;
        string error;
        if (!OpenOwned(owner, out error)) { detail = error; return RestoreResult.Failed; }
        try {
            ending = GetClipboardSequenceNumber();
            long endingOwner = ClipboardOwnerPid();
            Dictionary<uint, byte[]> current;
            if (!ReadFormats(out current, out error)) { detail = error; return RestoreResult.Failed; }
            // 同样不比较序列号：持有剪贴板锁的读取会推进它。
            // 已确认版本的所有者可能是守护进程（sentinel），也可能是产品进程
            // （已核验的产品复制），所以比较的是 confirmed.OwnerPid，不是自己的 PID。
            Snapshot actual = new Snapshot();
            actual.Sequence = ending;
            actual.OwnerPid = endingOwner;
            actual.Formats = current;
            // 只看内容：打开剪贴板本身会把所有者改成守护进程，所以这里不能用
            // 所有者判断“是否还是我们的版本”。
            bool unchanged = SameTextVersion(actual, confirmed);
            if (!unchanged) {
                detail = "结束序列=" + ending + " 确认序列=" + confirmed.Sequence + " 所有者=" + endingOwner +
                    " 确认所有者=" + confirmed.OwnerPid + " 格式数=" + current.Count;
                // 内容已经不属于我们：产品文本但不是已确认的所有者，说明有未归属
                // 写入；其他内容一律视为外部改动，保留现场。
                bool possibleCopy = ProductTextFormats(current) && endingOwner != confirmed.OwnerPid;
                return possibleCopy ? RestoreResult.Indeterminate : RestoreResult.SkippedExternalChange;
            }
            if (!WriteFormats(backup.Formats, out error)) { detail = error; return RestoreResult.Failed; }
            Dictionary<uint, byte[]> after;
            if (!ReadFormats(out after, out error)) { detail = error; return RestoreResult.Failed; }
            if (!FormatsCover(after, backup.Formats)) { detail = "恢复后内容与备份不一致"; return RestoreResult.Failed; }
            ending = GetClipboardSequenceNumber();
            endingOwnerPid = ClipboardOwnerPid();
            return RestoreResult.RestoredVerified;
        } finally { CloseClipboard(); }
    }

    public static int Run(string folder, string commandPipeName, string ackPipeName) {
        Dictionary<string, object> report = new Dictionary<string, object>();
        report["scenario"] = "clipboard-guardian";
        report["guardianPid"] = (long)Process.GetCurrentProcess().Id;
        report["testClipboardRestored"] = false;
        report["clipboardTouched"] = false;
        report["outcome"] = "untouched";

        string error;
        Snapshot backup = TakeSnapshot(out error);
        if (backup == null) { report["error"] = error; return WriteObject(folder, report); }
        report["backupFormatCount"] = (long)backup.Formats.Count;
        report["backupSequence"] = (long)backup.Sequence;
        report["backupOwnerPid"] = backup.OwnerPid;

        // 命令与回执走两条单向管道：这样可以只断开回执方向来验证“ACK 无人
        // 接收”，而命令方向的 EOF 才表示 fixture 已死亡。
        NamedPipeClientStream commandPipe = null, ackPipe = null;
        try {
            commandPipe = new NamedPipeClientStream(".", commandPipeName, PipeDirection.In);
            commandPipe.Connect(10000);
            ackPipe = new NamedPipeClientStream(".", ackPipeName, PipeDirection.Out);
            ackPipe.Connect(10000);
        } catch (Exception failure) {
            report["error"] = "无法连接验证管道：" + failure.Message;
            if (commandPipe != null) { try { commandPipe.Dispose(); } catch (Exception) { } }
            if (ackPipe != null) { try { ackPipe.Dispose(); } catch (Exception) { } }
            return WriteObject(folder, report);
        }

        IntPtr owner = CreateOwnerWindow();
        // confirmed 是“最后确认属于本测试的完整版本”（sentinel 或已核验的产品
        // 复制）。它同时保存序列号、全部格式和所有者 PID。
        Snapshot confirmed = null;
        bool initialized = false;
        if (TryWriteSentinel(owner, backup.Sequence, out confirmed, out error)) {
            initialized = true;
            report["clipboardTouched"] = true;
        } else report["error"] = error;
        report["sentinelWritten"] = initialized;
        if (confirmed != null) report["sentinelSequence"] = (long)confirmed.Sequence;

        Dictionary<string, object> ready = new Dictionary<string, object>();
        ready["ready"] = initialized;
        ready["sequence"] = confirmed == null ? 0L : (long)confirmed.Sequence;
        ready["guardianPid"] = (long)Process.GetCurrentProcess().Id;
        ready["backupFormatCount"] = (long)backup.Formats.Count;
        Reply(ackPipe, ready);

        bool unconfirmed = false;
        int claims = 0;
        if (initialized) {
            // 读取在后台线程，主线程持续泵消息：守护进程持有 sentinel 所有权
            // 期间必须能处理 WM_DESTROYCLIPBOARD，否则产品 EmptyClipboard 会
            // 阻塞约 5 秒（2026-10-25 OMEN 实测 5001ms 对 13ms）。
            CommandReader reader = new CommandReader(commandPipe);
            while (true) {
                Dictionary<string, object> command;
                int read = reader.TryRead(out command);
                // 命令管道结束（fixture 被强杀）与正常 finish 走同一条恢复路径。
                if (read == 0) break;
                if (read < 0) { unconfirmed = true; break; }
                string operation = Get(command, "operation") as string;
                if (operation == "finish") break;
                if (operation != "claim") { unconfirmed = true; break; }
                string expected = Get(command, "expected") as string;
                long productPid = ToLong(Get(command, "productPid"));
                bool product = ToBool(Get(command, "productCopyConfirmed"));
                bool allowed = expected == ProductText || expected == SecondProductText;
                Snapshot claimed = null;
                bool accepted = product && allowed && ClaimAccepted(confirmed, expected, productPid, out claimed);
                if (accepted) {
                    confirmed = claimed;
                    claims++;
                    // 后续被接受的声明已经覆盖了之前那一次未归属的内容，
                    // 因此不再把整轮判为不确定。
                    unconfirmed = false;
                    report.Remove("claimDrift");
                } else {
                    // 被拒绝的声明本身无害，前提是剪贴板确实还停在我们已确认的
                    // 那一版。只有内容已偏离（有未归属写入）时才放弃恢复。
                    string diagnoseError;
                    Snapshot now = TakeSnapshot(out diagnoseError);
                    bool stillOwned = SameTextVersion(now, confirmed);
                    report["claimStillOwned"] = stillOwned;
                    if (!stillOwned) {
                        report["claimDrift"] = DescribeDifference(now, confirmed);
                        unconfirmed = true;
                    }
                }
                report["claimRejected"] = !accepted;
                report["claimed"] = accepted;
                report["claimOwnerPid"] = ClipboardOwnerPid();
                Dictionary<string, object> ack = new Dictionary<string, object>();
                ack["accepted"] = accepted;
                // 回执断管只影响回执本身，不改变已核验的版本归属。
                Reply(ackPipe, ack);
            }
        }
        try { commandPipe.Dispose(); } catch (Exception) { }
        try { ackPipe.Dispose(); } catch (Exception) { }
        report["claims"] = (long)claims;
        if (confirmed != null) report["confirmedSequence"] = (long)confirmed.Sequence;

        string outcome;
        if (!initialized) outcome = "untouched";
        else if (unconfirmed) {
            outcome = "indeterminate";
            report["endingSequence"] = (long)GetClipboardSequenceNumber();
            report["endingOwnerPid"] = ClipboardOwnerPid();
        } else {
            uint restoredSequence;
            long restoredOwnerPid;
            string detail;
            RestoreResult result = Restore(owner, backup, confirmed, out restoredSequence, out restoredOwnerPid, out detail);
            report["restoreEndingSequence"] = (long)restoredSequence;
            report["restoreEndingOwnerPid"] = restoredOwnerPid;
            if (detail != null) report["restoreDetail"] = detail;
            if (result == RestoreResult.RestoredVerified) {
                outcome = "restoredVerified";
                report["testClipboardRestored"] = true;
            } else if (result == RestoreResult.SkippedExternalChange) outcome = "skippedExternalChange";
            else if (result == RestoreResult.Indeterminate) outcome = "indeterminate";
            else outcome = "restoreFailed";
        }
        report["outcome"] = outcome;
        // 从未写入测试内容时，用户剪贴板仍处于测试前状态，这本身就是已核验的结果。
        if (outcome == "untouched") report["testClipboardRestored"] = true;
        return WriteObject(folder, report);
    }

    internal static object Get(Dictionary<string, object> map, string key) {
        object value;
        return map != null && map.TryGetValue(key, out value) ? value : null;
    }
    public static bool ToBool(object value) { return value is bool && (bool)value; }
    public static long ToLong(object value) {
        if (value is long) return (long)value;
        if (value is int) return (int)value;
        return -1;
    }
    public static bool ToBoolValue(Dictionary<string, object> map, string key) { return ToBool(Get(map, key)); }
    public static long ToLongValue(Dictionary<string, object> map, string key) { return ToLong(Get(map, key)); }

    internal static bool Reply(Stream pipe, Dictionary<string, object> value) {
        if (pipe == null) return false;
        try {
            byte[] line = Encoding.UTF8.GetBytes(Serialize(value) + "\n");
            pipe.Write(line, 0, line.Length);
            pipe.Flush();
            return true;
        } catch (IOException) { return false; }
        catch (ObjectDisposedException) { return false; }
        catch (NotSupportedException) { return false; }
        // 管道尚未连接时 Write 抛 InvalidOperationException；这是“回执送不到”，
        // 不是致命错误，绝不能让它从清理路径冒出来掩盖原始失败。
        catch (InvalidOperationException) { return false; }
    }

    // 1 = 读到命令，0 = 管道结束，-1 = 命令无法解析。
    // 这是阻塞式读取，只给 fixture 侧用；守护进程必须用 CommandReader，
    // 否则持有剪贴板所有权期间不会处理 WM_DESTROYCLIPBOARD。
    internal static int ReadCommand(Stream pipe, out Dictionary<string, object> command) {
        command = null;
        if (pipe == null) return 0;
        List<byte> line = new List<byte>();
        try {
            while (line.Count < MaxCommandBytes) {
                int value = pipe.ReadByte();
                if (value < 0) return 0;
                if (value == '\n') {
                    command = Parse(Encoding.UTF8.GetString(line.ToArray()));
                    return command == null ? -1 : 1;
                }
                line.Add((byte)value);
            }
        } catch (IOException) { return 0; }
        catch (ObjectDisposedException) { return 0; }
        catch (NotSupportedException) { return 0; }
        return -1;
    }

    // 守护进程专用：读取在后台线程进行，主线程负责泵消息。
    // 这样既不会阻塞 WM_DESTROYCLIPBOARD 的处理，也保证所有剪贴板调用
    // 仍然只发生在创建所有者窗口的那个线程上。
    internal sealed class CommandReader {
        readonly Stream pipe;
        readonly Queue<object> lines = new Queue<object>();
        readonly object gate = new object();
        readonly Thread thread;
        volatile bool ended;

        public CommandReader(Stream source) {
            pipe = source;
            thread = new Thread(Loop) { IsBackground = true, Name = "guardian-command-reader" };
            thread.Start();
        }
        void Loop() {
            List<byte> line = new List<byte>();
            try {
                while (line.Count < MaxCommandBytes) {
                    int value = pipe.ReadByte();
                    if (value < 0) { ended = true; return; }
                    if (value == '\n') {
                        Dictionary<string, object> command = Parse(Encoding.UTF8.GetString(line.ToArray()));
                        lock (gate) lines.Enqueue(command == null ? (object)null : command);
                        line.Clear();
                        continue;
                    }
                    line.Add((byte)value);
                }
                lock (gate) lines.Enqueue(null);
                ended = true;
            } catch (Exception) { ended = true; }
        }
        // 1 = 命令，0 = 管道结束，-1 = 无法解析。
        public int TryRead(out Dictionary<string, object> command) {
            while (true) {
                PumpMessages();
                lock (gate) {
                    if (lines.Count > 0) {
                        object item = lines.Dequeue();
                        if (item == null) { command = null; return -1; }
                        command = (Dictionary<string, object>)item;
                        return 1;
                    }
                }
                if (ended) { command = null; return 0; }
                Thread.Sleep(5);
            }
        }
    }

    internal static Dictionary<string, object> ReadReport(string folder) {
        string path = Path.Combine(folder, "clipboard-guardian.json");
        if (!File.Exists(path)) return null;
        try { return Parse(File.ReadAllText(path, Encoding.UTF8)); }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    internal static int WriteObject(string folder, Dictionary<string, object> value) {
        // 报告在全部剪贴板操作结束后一次写出；持有者会等待本进程退出后
        // 才读取，因此不需要原子改名。
        try {
            File.WriteAllText(Path.Combine(folder, "clipboard-guardian.json"),
                "{\n  " + string.Join(",\n  ", new List<string>(Lines(value)).ToArray()) + "\n}", new UTF8Encoding(false));
        } catch (Exception failure) {
            value["reportError"] = failure.Message;
            return 1;
        }
        return ToBool(Get(value, "testClipboardRestored")) ? 0 : 1;
    }

    static IEnumerable<string> Lines(Dictionary<string, object> value) {
        foreach (KeyValuePair<string, object> item in value) yield return Quote(item.Key) + ": " + Literal(item.Value);
    }

    internal static string Serialize(Dictionary<string, object> value) {
        return "{" + string.Join(",", new List<string>(Lines(value)).ToArray()) + "}";
    }

    internal static string Literal(object value) {
        if (value == null) return "null";
        if (value is bool) return (bool)value ? "true" : "false";
        if (value is long) return ((long)value).ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (value is int) return ((int)value).ToString(System.Globalization.CultureInfo.InvariantCulture);
        Dictionary<string, object> map = value as Dictionary<string, object>;
        if (map != null) return Serialize(map);
        return Quote(value.ToString());
    }

    internal static string Quote(string text) {
        StringBuilder builder = new StringBuilder("\"");
        foreach (char character in text ?? string.Empty) {
            switch (character) {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20) builder.Append("\\u").Append(((int)character).ToString("x4"));
                    else builder.Append(character);
                    break;
            }
        }
        return builder.Append('"').ToString();
    }

    static void Skip(string text, ref int index) {
        while (index < text.Length && char.IsWhiteSpace(text[index])) index++;
    }

    static string ReadString(string text, ref int index) {
        if (index >= text.Length || text[index] != '"') return null;
        index++;
        StringBuilder builder = new StringBuilder();
        while (index < text.Length) {
            char character = text[index++];
            if (character == '"') return builder.ToString();
            if (character != '\\') { builder.Append(character); continue; }
            if (index >= text.Length) return null;
            char escape = text[index++];
            switch (escape) {
                case '"': builder.Append('"'); break;
                case '\\': builder.Append('\\'); break;
                case '/': builder.Append('/'); break;
                case 'b': builder.Append('\b'); break;
                case 'f': builder.Append('\f'); break;
                case 'n': builder.Append('\n'); break;
                case 'r': builder.Append('\r'); break;
                case 't': builder.Append('\t'); break;
                case 'u':
                    if (index + 4 > text.Length) return null;
                    int code;
                    if (!int.TryParse(text.Substring(index, 4), System.Globalization.NumberStyles.HexNumber, null, out code)) return null;
                    builder.Append((char)code);
                    index += 4;
                    break;
                default: return null;
            }
        }
        return null;
    }

    static bool ReadValue(string text, ref int index, out object value) {
        value = null;
        if (index >= text.Length) return false;
        if (text[index] == '"') {
            string parsed = ReadString(text, ref index);
            if (parsed == null) return false;
            value = parsed;
            return true;
        }
        if (index + 4 <= text.Length && string.CompareOrdinal(text, index, "true", 0, 4) == 0) { index += 4; value = true; return true; }
        if (index + 5 <= text.Length && string.CompareOrdinal(text, index, "false", 0, 5) == 0) { index += 5; value = false; return true; }
        if (index + 4 <= text.Length && string.CompareOrdinal(text, index, "null", 0, 4) == 0) { index += 4; value = null; return true; }
        int start = index;
        if (text[index] == '-' || text[index] == '+') index++;
        while (index < text.Length && (char.IsDigit(text[index]) || text[index] == '.' || text[index] == 'e' ||
            text[index] == 'E' || text[index] == '+' || text[index] == '-')) index++;
        if (index == start) return false;
        double number;
        if (!double.TryParse(text.Substring(start, index - start), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out number)) return false;
        value = (long)number;
        return true;
    }

    // 只解析本组测试工具自己写出的扁平对象（字符串、布尔、数字），不做通用 JSON。
    internal static Dictionary<string, object> Parse(string text) {
        if (text == null) return null;
        int index = 0;
        Skip(text, ref index);
        if (index >= text.Length || text[index] != '{') return null;
        index++;
        Dictionary<string, object> result = new Dictionary<string, object>();
        Skip(text, ref index);
        if (index < text.Length && text[index] == '}') return result;
        while (true) {
            Skip(text, ref index);
            string key = ReadString(text, ref index);
            if (key == null) return null;
            Skip(text, ref index);
            if (index >= text.Length || text[index] != ':') return null;
            index++;
            Skip(text, ref index);
            object value;
            if (!ReadValue(text, ref index, out value)) return null;
            result[key] = value;
            Skip(text, ref index);
            if (index >= text.Length) return null;
            if (text[index] == ',') { index++; continue; }
            if (text[index] == '}') return result;
            return null;
        }
    }
}

// fixture 侧只持有管道和进程句柄；备份始终在守护进程内存中。
class GuardianSession : IDisposable {
    public int GuardianPid { get; private set; }
    public uint Sequence { get; private set; }
    public int BackupFormatCount { get; private set; }
    public int? ExitCode { get; private set; }
    // 只有本次守护进程自己报告恢复成功且退出码为 0 时才为真。untouched 表示
    // 守护进程从未写入测试内容，用户剪贴板仍是测试前状态。
    public bool RestoredVerified {
        get { return ExitCode == 0 && (LastOutcome == "restoredVerified" || LastOutcome == "untouched"); }
    }
    public string LastOutcome { get; private set; }

    string folder;
    NamedPipeServerStream commands, acknowledgements;
    Process process;

    // .NET 4.0 的 NamedPipeServerStream.WaitForConnection 没有超时参数，且
    // BeginWaitForConnection 要求管道以异步模式打开。这里用后台线程做有界等待，
    // 避免 fixture 无限挂住，也不改变管道的同步读写语义。
    static void WaitForConnection(NamedPipeServerStream pipe, int milliseconds) {
        Exception failure = null;
        ManualResetEvent connected = new ManualResetEvent(false);
        Thread waiter = new Thread(delegate() {
            try { pipe.WaitForConnection(); }
            catch (Exception error) { failure = error; }
            finally { connected.Set(); }
        });
        waiter.IsBackground = true;
        waiter.Start();
        bool ready = connected.WaitOne(milliseconds);
        connected.Close();
        if (!ready) throw new InvalidOperationException("剪贴板守护进程未在 " + milliseconds + "ms 内连接验证管道");
        if (failure != null) throw new InvalidOperationException("连接验证管道失败：" + failure.Message);
    }

    // 启动失败时必须留下原因：否则只剩一句“管道未连接”，无法判断是守护
    // 进程崩溃、备份被拒绝，还是超时。
    static string DescribeStartFailure(string reportPath) {
        if (!File.Exists(reportPath)) return "守护进程未写出报告";
        try {
            Dictionary<string, object> report = ClipboardGuardian.Parse(File.ReadAllText(reportPath));
            object error, outcome, sentinel;
            if (report == null) return "守护进程报告无法解析";
            report.TryGetValue("error", out error);
            report.TryGetValue("outcome", out outcome);
            report.TryGetValue("sentinelWritten", out sentinel);
            return "守护进程报告 outcome=" + (outcome ?? "null") + " sentinelWritten=" + (sentinel ?? "null") + " error=" + (error ?? "null");
        } catch (Exception failure) { return "读取守护进程报告失败：" + failure.Message; }
    }

    public static GuardianSession Start(string executable, string folder) {
        string reportPath = Path.Combine(folder, "clipboard-guardian.json");
        if (File.Exists(reportPath)) {
            try { File.Delete(reportPath); }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }
        string commandName = "copick-clipboard-in-" + Guid.NewGuid().ToString("N");
        string ackName = "copick-clipboard-out-" + Guid.NewGuid().ToString("N");
        GuardianSession session = new GuardianSession();
        session.folder = folder;
        Process process = null;
        try {
            // 两个方向各一条单向管道：只关闭回执端就能验证 ACK 断管，
            // 命令端 EOF 才表示 fixture 已死亡。
            // fixture 只写命令、只读回执；守护进程方向相反。
            session.commands = new NamedPipeServerStream(commandName, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None);
            session.acknowledgements = new NamedPipeServerStream(ackName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None);
            ProcessStartInfo start = new ProcessStartInfo(executable,
                "--clipboard-guardian \"" + folder + "\" " + commandName + " " + ackName);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            process = Process.Start(start);
            session.process = process;
            if (process == null) throw new InvalidOperationException("无法启动剪贴板守护进程");
            // 守护进程先备份并写 sentinel，再连管道；.NET 4.0 的
            // WaitForConnection 没有超时重载，用连接回调给出有界等待。
            WaitForConnection(session.commands, 15000);
            WaitForConnection(session.acknowledgements, 15000);
            Dictionary<string, object> ack;
            if (ClipboardGuardian.ReadCommand(session.acknowledgements, out ack) != 1)
                throw new InvalidOperationException("剪贴板守护进程未发送就绪回执");
            if (ClipboardGuardian.ToLongValue(ack, "guardianPid") != process.Id)
                throw new InvalidOperationException("就绪回执不属于本次守护进程");
            if (!ClipboardGuardian.ToBoolValue(ack, "ready"))
                throw new InvalidOperationException("剪贴板守护进程无法初始化备份");
            session.GuardianPid = process.Id;
            session.Sequence = (uint)ClipboardGuardian.ToLongValue(ack, "sequence");
            session.BackupFormatCount = (int)ClipboardGuardian.ToLongValue(ack, "backupFormatCount");
            return session;
        } catch (Exception failure) {
            // 启动失败时仍要尽力让守护进程完成恢复，不能留下测试 sentinel。
            session.Send("finish");
            session.Dispose();
            if (process != null) {
                try { if (!process.WaitForExit(20000)) process.Kill(); }
                catch (Exception) { }
            }
            string detail = DescribeStartFailure(reportPath);
            Console.Error.WriteLine("guardian start failed: " + failure.GetType().Name + ": " + failure.Message + " | " + detail);
            // 已写入的测试内容必须确认恢复；否则上层必须停止后续场景。
            Dictionary<string, object> late = ClipboardGuardian.ReadReport(folder);
            if (late == null || !ClipboardGuardian.ToBoolValue(late, "testClipboardRestored")) {
                string text = "无法确认剪贴板已恢复：" + detail;
                File.WriteAllText(reportPath, "{\n  \"outcome\": \"startFailed\",\n  \"error\": " + ClipboardGuardian.Quote(text) + "\n}",
                    new UTF8Encoding(false));
            }
            return null;
        }
    }

    bool Send(string operation) {
        if (commands == null) return false;
        Dictionary<string, object> command = new Dictionary<string, object>();
        command["operation"] = operation;
        return ClipboardGuardian.Reply(commands, command);
    }

    bool SendClaim(string expected, bool productCopyConfirmed, int productPid) {
        if (commands == null) return false;
        Dictionary<string, object> command = new Dictionary<string, object>();
        command["operation"] = "claim";
        command["sequence"] = (long)ClipboardGuardian.CurrentSequence();
        command["expected"] = expected;
        command["productCopyConfirmed"] = productCopyConfirmed;
        command["productPid"] = (long)productPid;
        return ClipboardGuardian.Reply(commands, command);
    }

    public bool Claim(string expected, bool productCopyConfirmed, int productPid) {
        uint sequence = ClipboardGuardian.CurrentSequence();
        if (!SendClaim(expected, productCopyConfirmed, productPid)) return false;
        Dictionary<string, object> ack;
        if (ClipboardGuardian.ReadCommand(acknowledgements, out ack) != 1) return false;
        bool accepted = ClipboardGuardian.ToBoolValue(ack, "accepted");
        if (accepted) Sequence = sequence;
        return accepted;
    }

    // 对抗 harness 用：写入 claim 后立即关闭回执端，不读取 accepted。
    // 随后关闭命令端，等价于 fixture 立刻死亡；守护进程写完 ACK 失败后
    // 会从命令端读到 EOF，走与强杀相同的恢复路径。
    public bool ClaimWithoutAck(string expected, bool productCopyConfirmed, int productPid) {
        bool written = SendClaim(expected, productCopyConfirmed, productPid);
        if (acknowledgements != null) { try { acknowledgements.Dispose(); } catch (Exception) { } acknowledgements = null; }
        if (commands != null) { try { commands.Dispose(); } catch (Exception) { } commands = null; }
        return written;
    }

    // 对抗 harness 用：不发送 finish，直接断开命令端，触发与强杀相同的恢复路径。
    public void Abandon() { Dispose(); }

    // 只等待退出并读取报告，不主动发送 finish。
    public Dictionary<string, object> AwaitReport(int milliseconds) {
        if (process == null) return null;
        process.WaitForExit(milliseconds);
        ExitCode = process.HasExited ? process.ExitCode : (int?)null;
        return ReadVerifiedReport();
    }

    public Dictionary<string, object> Finish() {
        if (process == null) return null;
        Send("finish");
        // 先给 finish 命令机会；守护进程无响应时才用断管触发同一条恢复路径。
        if (!process.WaitForExit(20000)) {
            // 关闭命令端等价于 fixture 死亡，守护进程会走同一条恢复路径。
            if (commands != null) { try { commands.Dispose(); } catch (Exception) { } commands = null; }
            if (!process.WaitForExit(15000)) {
                try { process.Kill(); } catch (Exception) { }
                process.WaitForExit(2000);
            }
        }
        Dispose();
        ExitCode = process.HasExited ? process.ExitCode : (int?)null;
        return ReadVerifiedReport();
    }

    Dictionary<string, object> ReadVerifiedReport() {
        Dictionary<string, object> report = ClipboardGuardian.ReadReport(folder);
        if (report == null) return null;
        // 旧报告绝不能被当成本次结果。
        if (ClipboardGuardian.ToLongValue(report, "guardianPid") != GuardianPid) return null;
        object outcome;
        LastOutcome = report.TryGetValue("outcome", out outcome) ? outcome as string : null;
        bool restored = ClipboardGuardian.ToBoolValue(report, "testClipboardRestored");
        // 报告声明已恢复，但进程没有正常退出，就不能采信这份声明。
        if (restored && ExitCode != 0) return null;
        return report;
    }

    public void Dispose() {
        if (commands != null) { try { commands.Dispose(); } catch (Exception) { } commands = null; }
        if (acknowledgements != null) { try { acknowledgements.Dispose(); } catch (Exception) { } acknowledgements = null; }
    }
}
