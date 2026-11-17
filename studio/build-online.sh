#!/bin/sh
# Собирает онлайн-версию студии (страница в Claude) в папку dist-online/.
# three.js и mp4-muxer страница берёт с cdn.jsdelivr.net (разрешён на страницах Claude).
set -e
cd "$(dirname "$0")"
D=dist-online
rm -rf "$D"; mkdir -p "$D/examples"
cp app.js engine.js backend-local.js backend-online.js ai-prompts.js "$D/"
cp "examples/Пример — встреча на улице/project.json" "$D/examples/primer.json"
sed -e 's#"three": "./node_modules/three/build/three.module.js", "three/addons/": "./node_modules/three/examples/jsm/"#"three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.min.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"#' \
    -e 's#<script type="module" src="./app.js"></script>#<script type="module">import { onlineBackend } from "./backend-online.js"; window.__backend = await onlineBackend(); await import("./app.js");</script>#' \
    index.html > "$D/index.html"
grep -q 'cdn.jsdelivr.net/npm/three@0.185.1' "$D/index.html" && grep -q 'onlineBackend' "$D/index.html"
echo "готово: $D"
