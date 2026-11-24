# 0002. Tailscale for HTTPS and remote access, with a loopback-only bind

- Status: accepted
- Date: 14/11/2026
- Amended by: ADR 0010 (the tailnet is shared with the family, so the app adds PIN sign-in; the loopback bind is unchanged)

## Context

The iPhone must reach the Mac server from home and away, over HTTPS (a PWA's service worker needs a secure context). Running TLS certificates, port forwarding or app-level login for a single-user app adds risk and upkeep.

## Decision

The server binds to `127.0.0.1` only; the address is hard-coded and not configurable. Remote access goes exclusively through `tailscale serve`, which terminates HTTPS at `https://<mac-name>.<tailnet>.ts.net` and forwards to the loopback port. The tailnet is the security boundary, so the app has no authentication of its own.

## Consequences

- Nothing on the LAN or internet can reach the server directly; only devices signed in to the user's tailnet can.
- HTTPS certificates come from Tailscale with no manual renewal.
- Anyone with access to the user's tailnet has full access to Bookshelf. This is acceptable for a personal tailnet and must be revisited if the tailnet is ever shared.
- The server must never be changed to bind `0.0.0.0`; a test checks the boot address.
