# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    # Chromium + rendering
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # CLI tools
    curl \
    git \
    poppler-utils \
    pandoc \
    ffmpeg \
    python3-pip \
    # Document skills dependencies
    libreoffice-nogui \
    qpdf \
    tesseract-ocr \
    && pip3 install --break-system-packages \
        python-docx openpyxl python-pptx reportlab pandas Pillow \
        "markitdown[pptx]" \
        pypdf pdfplumber pdf2image pytesseract \
        defusedxml lxml \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and document creation tools globally
RUN npm install -g agent-browser @anthropic-ai/claude-code docx pptxgenjs

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Pre-compile agent-runner at build time (warm cache)
RUN cd /app && npx tsc --outDir /tmp/dist-cache 2>&1 >&2 \
    && ln -s /app/node_modules /tmp/dist-cache/node_modules \
    && md5sum /app/src/index.ts | cut -d' ' -f1 > /tmp/dist-cache/.src-hash

# Entrypoint: use pre-built cache if source unchanged, recompile otherwise
RUN printf '#!/bin/bash\nset -e\nSRC_HASH=$(md5sum /app/src/index.ts 2>/dev/null | cut -d" " -f1 || echo "none")\nCACHE_HASH=$(cat /tmp/dist-cache/.src-hash 2>/dev/null || echo "")\nif [ "$SRC_HASH" = "$CACHE_HASH" ] && [ -f /tmp/dist-cache/index.js ]; then\n  ln -sf /tmp/dist-cache /tmp/dist\nelse\n  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\n  ln -sf /app/node_modules /tmp/dist/node_modules\nfi\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
