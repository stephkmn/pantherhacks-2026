#!/bin/bash

# CleanSky AI Setup Script
# Run this to set up the entire project
set -e

echo "🛸 CleanSky AI Setup Script"
echo "============================="
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.9+ first."
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

echo "✅ Prerequisites found"
echo ""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# Python environment setup
echo "📦 Setting up Python environment..."
python3 -m venv .venv
source .venv/bin/activate

# Install backend dependencies
pip install -r requirements.txt

echo "✅ Python environment setup complete"
echo ""

# Frontend setup
echo "📦 Setting up frontend..."
npm install

echo "✅ Frontend setup complete"
echo ""

echo "🎉 Setup complete!"
echo ""
echo "To run the application:"
echo ""
echo "Terminal 1 (Backend):"
echo "  cd $ROOT_DIR"
echo "  source .venv/bin/activate"
echo "  uvicorn backend.main:app --reload"
echo ""
echo "Terminal 2 (Frontend):"
echo "  cd $ROOT_DIR"
echo "  npm run dev"
echo ""
echo "Then open http://localhost:3000 in your browser"
echo ""
echo "Happy hacking! 🚀"
