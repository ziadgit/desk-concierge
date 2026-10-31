# Stage 1: build the Next.js inbox (CopilotKit UI + runtime).
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build \
 && cp -r .next/static .next/standalone/.next/ \
 && if [ -d public ]; then cp -r public .next/standalone/; fi

# Stage 2: Node for the inbox, Python for the device API, one container.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PATH="/venv/bin:$PATH"
COPY app.py start.sh ./
COPY --from=web /web/.next/standalone ./web
ENV DB_PATH=/data/concierge.db \
    NEXT_TELEMETRY_DISABLED=1 \
    COPILOTKIT_TELEMETRY_DISABLED=true
EXPOSE 8080
CMD ["./start.sh"]
