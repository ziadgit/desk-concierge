# Desk Concierge

Leave a Cardputer at your desk. Visitors type to it, Claude answers for you,
and you watch and reply from one live chat feed in the browser.

## What's a Cardputer?

<img src="https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/1178/Cardputer-Adv_01.webp" alt="M5Stack Cardputer-Adv: a card-sized computer with a small color screen above a 56-key keyboard" width="420">

*Photo: M5Stack*

The [M5Stack Cardputer-Adv](https://docs.m5stack.com/en/core/Cardputer-Adv) is a
programmable computer the size of a credit card: a 1.14" color screen (240 x 135) above a
56-key keyboard, running on an ESP32-S3 chip with Wi-Fi and Bluetooth, a 1500 mAh battery,
a speaker, and a BMI270 motion sensor. This project runs MicroPython on it (UIFlow 2.0
firmware).

It suits this job better than a phone: it's cheap and does one thing, so you can leave it on
a desk for strangers to use, and it has a real keyboard. Its motion sensor is how the
concierge knows when someone picks it up.

**Device code:** the Cardputer app lives in a fork of `build-with-claude`, on the
[`desk-concierge` branch](https://github.com/ziadgit/build-with-claude/tree/desk-concierge)
([`buddy/device/apps/concierge.py`](https://github.com/ziadgit/build-with-claude/blob/desk-concierge/buddy/device/apps/concierge.py)).

## How it works

- **Cardputer** (MicroPython): visitors type and press Enter. Each message goes to this
  server, Claude replies on the device's screen, and replies you type show up there too. The
  accelerometer reports when someone picks the device up or puts it down.
- **`app.py`** (FastAPI): the device API and storage (SQLite on a Fly volume). It asks Claude
  for each reply, returning short plain-ASCII text plus an urgent flag and a summary. It listens
  on localhost only.
- **`web/`** (Next.js + CopilotKit): the public server and the inbox, a single CopilotKit chat.
  - Visitor messages, the concierge's answers and pickup/put-down events stream in, with times
    to the second and how long the device was held.
  - You talk to an agent in the same feed. It can reply to visitors on the device, change the
    status the concierge tells people, and play the boop.
  - Urgent visitors wake the agent so it can flag them and suggest a reply.
  - A visitor typing "boop" plays a sound; `:)` and other emoticons show as emoji.
  - It proxies `/api/device`, `/api/owner` and `/healthz` to FastAPI.
- **`start.sh`**: runs both servers in one Fly container.

## Deploy to Fly

```bash
fly launch --copy-config --no-deploy        # pick a unique app name
fly volumes create concierge_data --size 1 --region sjc
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  DEVICE_TOKEN=$(openssl rand -hex 16) \
  OWNER_PASSWORD=pick-something             # optional, see below
fly deploy
```

If the app has no public address afterwards (`fly ips list` is empty), run
`fly ips allocate-v4 --shared && fly ips allocate-v6`.

`OWNER_PASSWORD` puts the inbox behind a browser login (any username, that password).
Without it the inbox is open to anyone with the URL, who can then read conversations,
message the device as you, and use the agent on your Claude credits. The device API
always requires `DEVICE_TOKEN`.

## Point the device at it

In the `build-with-claude` fork, on the `desk-concierge` branch:

```bash
cd buddy/device
cp concierge_config.example.py concierge_config.py   # set SERVER and TOKEN (gitignored)
python3 ../scripts/push.py --port /dev/cu.usbmodemXXXX --files apps/concierge.py concierge_config.py
```

Then pick `concierge` from the device menu. Tell the agent your status ("I'm at judging till
4") so the concierge knows what to say.

## Run locally

```bash
uv venv && uv pip install -r requirements.txt
(cd web && npm install)
cp .env.example .env   # fill in
set -a; . ./.env; set +a
.venv/bin/uvicorn app:app --reload --port 8000 &
(cd web && npm run dev)   # http://localhost:3000
```
