#!/bin/bash
# 编译 Swift 版 Copick，组装 .app 并签名。证书见 COPICK_SIGN_ID（默认 "Copick Dev"，缺失则 ad-hoc）。
set -euo pipefail
cd "$(dirname "$0")"
APP=../dist/Copick-swift/Copick.app
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -swift-version 5 -target arm64-apple-macos13.0 *.swift -o "$APP/Contents/MacOS/Copick"
vtool -show-build "$APP/Contents/MacOS/Copick" | grep -q "minos 13.0" || { echo "部署目标不是 13.0"; exit 1; }
strip "$APP/Contents/MacOS/Copick"
cp ../build/icon.icns "$APP/Contents/Resources/AppIcon.icns"
cp ../build/trayTemplate.png ../build/trayTemplate@2x.png "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Copick</string>
<key>CFBundleExecutable</key><string>Copick</string>
<key>CFBundleIdentifier</key><string>com.copick.app</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PL

ID="${COPICK_SIGN_ID:-Copick Dev}"
security find-identity -p codesigning | grep -q "\"$ID\"" || { echo "未找到证书 \"$ID\"，回退 ad-hoc"; ID="-"; }
codesign --force --sign "$ID" "$APP"
codesign --verify --strict "$APP"
echo "已生成：$APP（签名：$ID，$(du -sh "$APP" | cut -f1)）"
