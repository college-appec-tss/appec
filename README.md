# TextBee SMS Dashboard

A small student-friendly Node.js + Express + Fetch project. It uses a JSON file as persistent storage instead of a database.

## What it does
- Admin-token login.
- Shows Android gateway status using the TextBee device heartbeat.
- Saves every outgoing SMS to `data/store.json` before attempting to send.
- Leaves messages as `queued` while the gateway is offline.
- Retries queued messages automatically every few seconds after the gateway becomes online.
- Polls TextBee for the batch status and displays `sending`, `sent`, `delivered`, or `failed`.
- Uses only Node's built-in `fetch` for TextBee HTTP calls.
- Accessible labels, focus styles, live status announcements, clear primary actions, and a loading spinner.

## Setup
1. Copy `.env.example` to `.env`.
2. Put your TextBee API key and device ID in `.env`.
3. Choose a private `ADMIN_TOKEN`.
4. Run `npm install` then `npm start`.
5. Open http://localhost:3000.

## Persistence
`data/store.json` is the queue. Because it is written atomically through a temporary file and rename, queued messages survive a normal server restart.

## Status note
TextBee reports device heartbeat information rather than a simple universal `online: true` field. This project labels the device online when its last heartbeat is recent relative to the configured heartbeat interval; otherwise it shows offline/unknown. SMS delivery status comes from TextBee's message/batch status, where `delivered` means the carrier confirmed delivery.
