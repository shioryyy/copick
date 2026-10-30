const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

// 浮窗定位是纯几何：这里用桥接层同一份 placement.h 编译探针，
// 覆盖副屏在左侧、高度与主屏不同、负坐标与贴边锚点。
test('浮窗在工作区内定位，副屏坐标与主屏高度差异不影响结果', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'copick-placement-'));
  try {
    const source = path.join(directory, 'placement.cc');
    const executable = path.join(directory, process.platform === 'win32' ? 'placement.exe' : 'placement');
    const native = path.resolve(__dirname, '../src-tauri/native');
    writeFileSync(source, `
#include "placement.h"
#include <cassert>
#include <cmath>
static bool Near(double a, double b) { return std::fabs(a - b) < 1e-9; }
static void Expect(copick::Rect r, double x, double y) { assert(Near(r.x, x) && Near(r.y, y)); }
int main() {
    const double w = copick::kPopupWidth, h = copick::kPopupHeight;
    // 主屏工作区 1440x784。
    copick::Rect primary = {0, 0, 1440, 784};
    Expect(copick::PlacePopup(700, 400, primary), 710, 412);
    // 右边缘钳制。
    Expect(copick::PlacePopup(1390, 400, primary), 1440 - w, 412);
    Expect(copick::PlacePopup(1450, 400, primary), 1440 - w, 412);
    // 左边缘钳制。
    Expect(copick::PlacePopup(-50, 400, primary), 0, 412);
    // 下方放不下时翻到锚点上方。
    Expect(copick::PlacePopup(700, 770, primary), 710, 770 - 12 - h);
    // 锚点已经越过工作区底部时，翻到上方后仍落在工作区内。
    Expect(copick::PlacePopup(700, 790, primary), 710, 790 - 12 - h);
    // 上方也放不下时钳到工作区顶部。
    Expect(copick::PlacePopup(700, 3000, primary), 710, 784 - h);

    // 副屏在主屏左侧、比主屏高：屏幕坐标里 x 为负、y 区间也不同于主屏。
    // 主屏高 900，副屏 Cocoa frame (-2048,0,2048,1152) => 屏幕坐标 (-2048,-252,2048,1122)。
    copick::Rect secondary = {-2048, -252, 2048, 1122};
    Expect(copick::PlacePopup(-1000, -200, secondary), -990, -188);
    Expect(copick::PlacePopup(-1000, 840, secondary), -990, 840 - 12 - h);
    Expect(copick::PlacePopup(-2040, 400, secondary), -2030, 412);
    Expect(copick::PlacePopup(-2060, 400, secondary), -2048, 412);

    // 工作区比浮窗还窄/矮时贴着工作区，不产生负尺寸。
    copick::Rect narrow = {10, 20, 80, 30};
    Expect(copick::PlacePopup(100, 100, narrow), 10, 10);

    // Cocoa 与屏幕坐标互转，参考高度必须是主屏高度。
    assert(Near(copick::CocoaToScreenY(900, 900), 0));
    assert(Near(copick::CocoaToScreenY(0, 900), 900));
    assert(Near(copick::ScreenToCocoaY(-252, 900), 1152));
    assert(Near(copick::ScreenToCocoaY(copick::CocoaToScreenY(300, 900), 900), 300));
}
`);
    const compiler = process.env.CXX || (process.platform === 'win32' ? 'cl' : 'clang++');
    const msvc = /(?:^|[\\/])cl(?:\.exe)?$/i.test(compiler);
    const args = msvc
      ? ['/nologo', '/std:c++17', '/EHsc', '/utf-8', '/W4', '/WX', `/I${native}`, source, `/Fe:${executable}`, `/Fo:${path.join(directory, 'placement.obj')}`]
      : ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', native, source, '-o', executable];
    const compiled = spawnSync(compiler, args, { encoding: 'utf8', cwd: directory });
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
