FROM node:22-bookworm-slim

ENV PATH="/opt/venv/bin:$PATH" \
    NODE_ENV=production \
    PORT=10000 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      fontconfig \
      fonts-ipafont-gothic \
      fonts-ipafont-mincho \
      fonts-noto-cjk \
      lmodern \
      pandoc \
      python3 \
      python3-venv \
      texlive-fonts-recommended \
      texlive-lang-japanese \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-xetex && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir pymupdf && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY data ./data
COPY examples ./examples
COPY manual_test_assets ./manual_test_assets
COPY README.md ./README.md

RUN mkdir -p output .tmp_ui_uploads && chown -R node:node /app

USER node

EXPOSE 10000

CMD ["npm", "start"]
