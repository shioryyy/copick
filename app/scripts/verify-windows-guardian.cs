using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

// 对抗性剪贴板守护进程验收：每个场景都真实启动独立的守护进程进程，并核验
// 它的报告、退出码和剪贴板内容。外层只在本轮写入已被版本核验确认后才清理。
//
// 与 macOS 的关键差别：Windows 能拿到内容所有者的窗口 PID，因此“外部进程
// 写入了完全相同的文本”这种 macOS 只能判为不确定的情况，这里能判定归属。
static class GuardianVerification {
    const string ProductText = ClipboardGuardian.ProductText;
    const string Sentinel = ClipboardGuardian.Sentinel;

    static int failures;
    static string folder;
    static string executable;
    static ClipboardGuardian.Snapshot backup;

    static void Require(bool condition, string message) {
        if (condition) return;
        failures++;
        Console.Error.WriteLine("FAIL " + message);
    }

    // 不比较序列号：读取剪贴板本身会推进它，比较恒为假。内容与所有者足够。
    static bool SnapshotMatches(ClipboardGuardian.Snapshot expected, uint sequence) {
        ClipboardGuardian.Snapshot current = ClipboardGuardian.TakeSnapshot();
        return current != null && ClipboardGuardian.FormatsCover(current.Formats, expected.Formats);
    }

    static bool TextIs(string text, uint sequence) {
        ClipboardGuardian.Snapshot current = ClipboardGuardian.TakeSnapshot();
        return current != null && ClipboardGuardian.TextEquals(current.Formats, text);
    }

    static string Start(string scenario) {
        string run = Path.Combine(folder, scenario, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(run);
        return run;
    }

    // 外层写测试内容前必须先证明剪贴板仍是本轮 sentinel 且所有者是守护进程。
    static bool SentinelIntact(GuardianSession session) {
        return TextIs(Sentinel, session.Sequence) &&
            ClipboardGuardian.ClipboardOwnerPid() == session.GuardianPid;
    }

    // 场景收尾：先证明当前内容确实是本场景写的那一版，再用备份覆盖并核验。
    static bool Cleanup(uint expectedSequence, string expectedText) {
        if (expectedSequence != 0 && !TextIs(expectedText, expectedSequence)) return false;
        if (!ClipboardGuardian.RestoreSnapshot(backup)) return false;
        return SnapshotMatches(backup, ClipboardGuardian.CurrentSequence());
    }

    static void ExpectReport(GuardianSession session, string scenario, string outcome, bool restored, int? exitCode) {
        Dictionary<string, object> report = session.AwaitReport(20000);
        Require(report != null, scenario + ": guardian report missing");
        if (report == null) return;
        string actual = ClipboardGuardian.Get(report, "outcome") as string;
        Require(actual == outcome, scenario + ": expected outcome " + outcome + ", got " + actual);
        Require(ClipboardGuardian.ToBoolValue(report, "testClipboardRestored") == restored,
            scenario + ": testClipboardRestored mismatch");
        Require(ClipboardGuardian.ToLongValue(report, "guardianPid") == session.GuardianPid,
            scenario + ": report belongs to another guardian process");
        if (exitCode.HasValue) Require(session.ExitCode == exitCode.Value, scenario + ": guardian exit code " + session.ExitCode);
    }

    // 正常完成：守护进程自己恢复，报告和退出码都必须是成功。
    static void FinishRestored() {
        string scenario = "finish-restored";
        GuardianSession session = GuardianSession.Start(executable, Start(scenario));
        Require(session != null, scenario + ": guardian did not start");
        if (session == null) return;
        Require(SentinelIntact(session), scenario + ": sentinel not verified");
        Dictionary<string, object> report = session.Finish();
        Require(report != null, scenario + ": guardian report missing");
        if (report != null) {
            Require((ClipboardGuardian.Get(report, "outcome") as string) == "restoredVerified", scenario + ": wrong outcome");
            Require(ClipboardGuardian.ToBoolValue(report, "testClipboardRestored"), scenario + ": restore not reported");
            Require(session.ExitCode == 0, scenario + ": guardian exit code " + session.ExitCode);
        }
        Require(SnapshotMatches(backup, ClipboardGuardian.CurrentSequence()), scenario + ": clipboard not restored");
        Console.WriteLine(scenario + " ok");
    }

    // fixture 被强杀等价于管道 EOF：备份只在守护进程内存中，它必须自行恢复。
    static void OwnerKilled() {
        string scenario = "owner-killed";
        GuardianSession session = GuardianSession.Start(executable, Start(scenario));
        Require(session != null, scenario + ": guardian did not start");
        if (session == null) return;
        Require(SentinelIntact(session), scenario + ": sentinel not verified");
        session.Abandon();
        ExpectReport(session, scenario, "restoredVerified", true, 0);
        Require(SnapshotMatches(backup, ClipboardGuardian.CurrentSequence()), scenario + ": clipboard not restored");
        Console.WriteLine(scenario + " ok");
    }

    // 外部写入必须保留现场：不覆盖别人的内容，并明确报告跳过。
    static void ExternalWriteKilled() {
        string scenario = "external-write-killed";
        GuardianSession session = GuardianSession.Start(executable, Start(scenario));
        Require(session != null, scenario + ": guardian did not start");
        if (session == null) return;
        if (!SentinelIntact(session)) { Require(false, scenario + ": sentinel not verified"); return; }
        string external = "guardian-external-" + Guid.NewGuid().ToString("N");
        uint externalSequence;
        string error;
        Require(ClipboardGuardian.TryWriteText(external, out externalSequence, out error), scenario + ": external write failed: " + error);
        session.Abandon();
        ExpectReport(session, scenario, "skippedExternalChange", false, 1);
        Require(TextIs(external, externalSequence), scenario + ": external content was overwritten");
        Require(Cleanup(externalSequence, external), scenario + ": cleanup failed");
        Console.WriteLine(scenario + " ok");
    }

    // 外部进程写入与产品完全相同的文本：macOS 只能判为不确定，这里靠所有者
    // PID 判定它不是产品写的，因此不得恢复覆盖。
    static void SameTextUnclaimedKilled() {
        string scenario = "same-text-unclaimed-killed";
        GuardianSession session = GuardianSession.Start(executable, Start(scenario));
        Require(session != null, scenario + ": guardian did not start");
        if (session == null) return;
        if (!SentinelIntact(session)) { Require(false, scenario + ": sentinel not verified"); return; }
        uint sequence;
        string error;
        Require(ClipboardGuardian.TryWriteText(ProductText, out sequence, out error), scenario + ": product text write failed: " + error);
        Require(ClipboardGuardian.ClipboardOwnerPid() == Process.GetCurrentProcess().Id, scenario + ": owner is not this process");
        session.Abandon();
        ExpectReport(session, scenario, "indeterminate", false, 1);
        Require(TextIs(ProductText, sequence), scenario + ": unclaimed product text was overwritten");
        Require(Cleanup(sequence, ProductText), scenario + ": cleanup failed");
        Console.WriteLine(scenario + " ok");
    }

    // 真正的产品复制：文本、序列号、全部格式和所有者 PID 全部匹配才接受声明。
    static void VerifiedCopyKilled() {
        string scenario = "verified-copy-killed";
        GuardianSession session = GuardianSession.Start(executable, Start(scenario));
        Require(session != null, scenario + ": guardian did not start");
        if (session == null) return;
        if (!SentinelIntact(session)) { Require(false, scenario + ": sentinel not verified"); return; }
        uint sequence;
        string error;
        Require(ClipboardGuardian.TryWriteText(ProductText, out sequence, out error), scenario + ": product text write failed: " + error);
        int productPid = Process.GetCurrentProcess().Id;
        // 先确认写入后剪贴板确实是我们的版本，排除外部进程在测试中途改写。
        Require(TextIs(ProductText, sequence), scenario + ": product text not readable right after write");
        Require(ClipboardGuardian.ClipboardOwnerPid() == productPid, scenario + ": product text owner is not this process");
        // 每一项单独缺失都必须被拒绝，不能因为“文本对了”就通过。
        Require(!session.Claim(ProductText, false, productPid), scenario + ": claim accepted without product confirmation");
        Require(!session.Claim(ProductText, true, productPid + 100000), scenario + ": claim accepted for a foreign owner pid");
        Require(!session.Claim(ClipboardGuardian.SecondProductText, true, productPid), scenario + ": claim accepted for mismatched text");
        Require(session.Claim(ProductText, true, productPid), scenario + ": verified product claim was rejected");
        session.Abandon();
        ExpectReport(session, scenario, "restoredVerified", true, 0);
        Require(SnapshotMatches(backup, ClipboardGuardian.CurrentSequence()), scenario + ": clipboard not restored");
        Console.WriteLine(scenario + " ok");
    }

    // 回执断管：fixture 在声明后立即死亡，守护进程写 ACK 会失败，但版本
    // 归属已核验，恢复仍必须完成。
    static void ClaimAckDisconnect() {
        string scenario = "claim-ack-disconnect";
        GuardianSession session = GuardianSession.Start(executable, Start(scenario));
        Require(session != null, scenario + ": guardian did not start");
        if (session == null) return;
        if (!SentinelIntact(session)) { Require(false, scenario + ": sentinel not verified"); return; }
        uint sequence;
        string error;
        Require(ClipboardGuardian.TryWriteText(ProductText, out sequence, out error), scenario + ": product text write failed: " + error);
        // 声明与断管同时发生：先写 claim，然后立即关闭管道，不读取 ACK。
        int productPid = Process.GetCurrentProcess().Id;
        bool claimed = session.ClaimWithoutAck(ProductText, true, productPid);
        Require(claimed, scenario + ": claim command could not be written");
        ExpectReport(session, scenario, "restoredVerified", true, 0);
        Require(SnapshotMatches(backup, ClipboardGuardian.CurrentSequence()), scenario + ": clipboard not restored");
        Console.WriteLine(scenario + " ok");
    }

    // Session 0 没有用户交互桌面的剪贴板，SSH 直接运行会读到无关进程的内容，
    // 结果不可采信。必须在已登录的交互桌面通过计划任务运行。
    static bool RequireInteractiveSession() {
        if (Process.GetCurrentProcess().SessionId != 0) return true;
        Console.Error.WriteLine("Session 0 has no user clipboard; run through start-windows-verification.ps1 on the interactive desktop. No clipboard write was attempted.");
        return false;
    }

    static int Main(string[] args) {
        // 本 harness 自己也是守护进程的可执行文件：每个场景都用 --clipboard-guardian
        // 重新启动本进程的独立实例，备份只存在那个实例的内存里。
        if (args.Length == 4 && args[0] == "--clipboard-guardian")
            return ClipboardGuardian.Run(args[1], args[2], args[3]);
        if (args.Length != 2) { Console.Error.WriteLine("usage: verify-windows-guardian <executable> <folder>"); return 2; }
        if (!RequireInteractiveSession()) return 3;
        executable = args[0];
        folder = args[1];
        Directory.CreateDirectory(folder);
        backup = ClipboardGuardian.TakeSnapshot();
        if (backup == null) {
            Console.Error.WriteLine("Cannot completely back up the clipboard; no test write was attempted.");
            return 1;
        }
        try {
            FinishRestored();
            OwnerKilled();
            ExternalWriteKilled();
            SameTextUnclaimedKilled();
            VerifiedCopyKilled();
            ClaimAckDisconnect();
        } finally {
            // 最后核验用户剪贴板确实回到测试前状态，否则整个 harness 失败。
            if (!SnapshotMatches(backup, ClipboardGuardian.CurrentSequence())) {
                failures++;
                Console.Error.WriteLine("FAIL clipboard was not restored to the pre-run state");
            }
        }
        Dictionary<string, object> report = new Dictionary<string, object>();
        report["scenario"] = "clipboard-guardian";
        report["sourcePid"] = (long)Process.GetCurrentProcess().Id;
        report["passed"] = failures == 0;
        report["testClipboardRestored"] = SnapshotMatches(backup, ClipboardGuardian.CurrentSequence());
        report["backupFormatCount"] = (long)backup.Formats.Count;
        report["baselineSequence"] = (long)backup.Sequence;
        report["failures"] = (long)failures;
        report["evidenceLimits"] =
            "Sequence, all formats and GetClipboardOwner PID are verified inside a single OpenClipboard lock, so a concurrent writer cannot interleave between the check and the restore. " +
            "Not covered: killing the guardian process itself, a process that holds the clipboard lock forever, formats excluded by the copy whitelist (GDI, owner-display, metafile, private), " +
            "and the full product copy path (this harness writes test text directly).";
        List<string> lines = new List<string>();
        foreach (KeyValuePair<string, object> item in report) lines.Add("  " + ClipboardGuardian.Quote(item.Key) + ": " + ClipboardGuardian.Literal(item.Value));
        string json = "{\n" + string.Join(",\n", lines.ToArray()) + "\n}";
        File.WriteAllText(Path.Combine(folder, "verification.json"), json, new UTF8Encoding(false));
        Console.WriteLine(json);
        return failures == 0 ? 0 : 1;
    }
}
