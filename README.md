# OpenCall

Mesh WebRTC calling for up to 6 friends. Audio and video travel directly
between browsers. The server only relays small text messages so the
browsers can find each other.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000

To test properly, open a second tab (or a second browser) and join the same
channel. Use headphones or mute one tab, otherwise you'll get feedback.

## Put it on the internet

Any Node host with WebSocket support works. All of these have a free tier:

**Render** — new Web Service, connect the repo, build `npm install`, start
`npm start`. HTTPS is automatic.

**Railway** — `railway up`. Same deal.

**Fly.io** — `fly launch`, then `fly deploy`.

**A $5 VPS** — run it behind Caddy, which gets you HTTPS in two lines:

```
call.yourdomain.com {
  reverse_proxy localhost:3000
}
```

HTTPS is not optional. Browsers refuse camera and mic access on plain HTTP
everywhere except localhost.

## If someone can't connect

Watch the readout in the corner of each tile. It shows `direct` once media
is flowing, and the round-trip time. If a tile sits on `connecting` forever
or flips to `no route`, that connection couldn't find a path — that person
is behind a NAT or firewall that blocks direct peer-to-peer.

The fix is a TURN server, which relays the media. Install coturn on any
small VPS:

```bash
sudo apt install coturn
```

In `/etc/turnserver.conf`:

```
listening-port=3478
fingerprint
lt-cred-mech
user=friend:somelongpassword
realm=yourdomain.com
external-ip=YOUR_SERVER_IP
```

Then uncomment the TURN block near the top of `public/index.html` and fill
in your host and credentials. The readout will start showing `relay` for
connections that need it.

TURN traffic costs real bandwidth — roughly 1–2 GB per hour of relayed
video per person. Only some connections need it.

## What's inside

- `server.js` — static file host plus a WebSocket relay for SDP and ICE.
  Never sees media.
- `public/index.html` — the whole client: preflight screen, mesh peer
  connections, call UI.

## Why 6 people

Mesh means everyone uploads a separate stream to everyone else. At 6 people
that's 5 outbound streams each, which is roughly where laptop fans and home
upload speeds give out. Past that you want an SFU — LiveKit is the easiest
one to move to, and the signaling concepts carry over.

## Not included

No accounts, no recording, no end-to-end encryption beyond WebRTC's built-in
DTLS-SRTP (which already encrypts everything in transit). Anyone with the
channel name can walk in. That's fine for friends; it isn't fine for
anything else.
