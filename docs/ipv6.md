# IPv6 web access (first phase)

The first IPv6 phase covers **the web page, Node API and WebSocket**. IPv4
continues to work unchanged.

## What works over IPv6

- The play page: `http://[IPv6-address]:5000`
- Node HTTP endpoints and the control WebSocket: `http://[IPv6-address]:5050`
- WHEP requests and the WebSocket use the IPv6 page host automatically when
  the page was opened through an IPv6 literal.
- The IPv4 page, IPv4 Node API and IPv4 WebSocket are unchanged.

## What is still IPv4

- **Pico control** (UDP 30100/30101) remains IPv4; lwIP in the firmware is
  built with `LWIP_IPV6 0`. Node bridges the browser to the IPv4 Pico.
- **WebRTC media** still uses the IPv4 MediaMTX ICE candidate. A dual-stack
  phone can watch the video over IPv4 while the page/control run over IPv6.
  An IPv6-only phone can load the page but cannot receive the video yet.
- Discovery is still IPv4 broadcast; this does not affect page access.

## Using it

1. Find a **global or ULA IPv6 address** for the PC, for example:

   ```powershell
   Get-NetIPAddress -AddressFamily IPv6 |
     Where-Object { $_.IPAddress -notmatch '^fe80' -and $_.IPAddress -ne '::1' }
   ```

   Do not use a `fe80::` link-local address; browsers cannot use its zone id.
2. Put the iPhone/iPad on the same IPv6 LAN (same /64 prefix) and open:

   ```text
   http://[2409:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx]:5000/
   ```

3. Allow inbound TCP **5000 and 5050** in Windows Firewall for the Deno
   runtime or the application. Do not port-forward these ports.
4. If the page loads but the video keeps waiting, check whether the phone has
   an IPv4 address; that is the remaining IPv4 ICE limitation.

## Security

IPv6 global addresses are globally routable, unlike a typical IPv4 NAT address.
Treat ports 5000/5050 as LAN-only:

- Set a **Node password** in the launcher before enabling IPv6 access.
- Keep Windows Firewall and the router firewall enabled; block inbound
  connections from the WAN.
- Do not forward 5000/5050 on the router.
- The Pico pairing key and Wi-Fi credentials are not needed by the web page.

## Implementation

- `apps/node/src/index.ts` starts a second `Deno.serve` listener on `::` beside
  the existing IPv4 listener. Both share the same routes, auth and WebSocket
  state.
- `apps/client/src/index.ts` keeps the Slick page server on IPv4 and adds an
  IPv6 TCP proxy on `::` that forwards to `127.0.0.1`. Slick itself cannot bind
  a hostname; this preserves IPv4 and adds IPv6.
- `apps/client/src/islands/play.tsx` derives the Node URL from
  `location.hostname` when it is an IPv6 literal. IPv4 and hostname URLs keep
  using the configured `NODE_BASE_URL`.

## Verification

- `http://127.0.0.1:5000` and `http://[::1]:5000` both return 200.
- `http://127.0.0.1:5050/health` and `http://[::1]:5050/health` both return 200.
- A headless iPhone-UA browser loaded the IPv6 loopback and global-address
  pages, derived `[IPv6]:5050`, connected the WebSocket, claimed P1 and sent
  gamepad frames.
- The same test over IPv4 still passes.
- The IPv6 global page loaded the stream in the dual-stack test; WHEP media
  remained on the IPv4 ICE candidate.

This does not make the Pico itself IPv6-capable. Direct Pico IPv6 would need
IPv6 in lwIP, SLAAC/DHCPv6 and mDNS AAAA support.
