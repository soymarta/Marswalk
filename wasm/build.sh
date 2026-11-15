#!/usr/bin/env bash
# Compila el núcleo de búsqueda a WebAssembly → js/ruta/ruta_kernel.wasm
# Requisitos (Fedora): sudo dnf install clang lld binaryen
set -euo pipefail
cd "$(dirname "$0")"
OUT=../js/ruta/ruta_kernel.wasm
clang --target=wasm32 -O3 -flto -nostdlib -fno-math-errno \
      -mbulk-memory -msimd128 \
      -Wl,--no-entry -Wl,--export-dynamic -Wl,--lto-O3 \
      -Wl,--growable-table -Wl,--initial-memory=33554432 -Wl,--max-memory=2147483648 \
      -o "$OUT" ruta_kernel.c
if command -v wasm-opt >/dev/null; then wasm-opt -O3 --enable-bulk-memory --enable-simd "$OUT" -o "$OUT"; fi
echo "✓ $(du -h "$OUT" | cut -f1)  $OUT"
