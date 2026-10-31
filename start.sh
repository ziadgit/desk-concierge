#!/bin/bash
# FastAPI (device API + data) on localhost only; Next.js (inbox +
# CopilotKit) is the public server and proxies /api/device, /api/owner and
# /healthz to it. If either process dies, exit so Fly restarts the machine.
uvicorn app:app --host 127.0.0.1 --port 8000 &
(cd web && PORT=8080 HOSTNAME=0.0.0.0 exec node server.js) &
wait -n
exit $?
