#!/usr/bin/env bash
# setup.sh — Instalación de dependencias del proyecto

set -e

echo "══════════════════════════════════════════════════════════"
echo "        Instalación del proyecto Mapa de Marte"
echo "══════════════════════════════════════════════════════════"
# ─── 1. Dependencias del sistema ─────────────────────────────────
echo "[1/3] Instalando dependencias del sistema (GDAL, Python)..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y gdal-bin python3-gdal python3-pip python3-venv
elif command -v brew &> /dev/null; then
    brew install gdal python3
else
    echo "No se detectó apt-get ni brew. Instala GDAL manualmente."
    exit 1
fi

# ─── 2. Entorno virtual de Python ────────────────────────────────
echo "[2/3] Creando entorno virtual..."
if [ ! -d "venv-marte" ]; then
    python3 -m venv venv-marte
fi
source venv-marte/bin/activate

# ─── 3. Dependencias Python ──────────────────────────────────────
echo "[3/3] Instalando dependencias Python..."
pip install --upgrade pip
pip install -r requirements.txt

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Instalación completada"
echo "  Para activar el entorno: source venv-marte/bin/activate"
echo "═══════════════════════════════════════════════════════════════"