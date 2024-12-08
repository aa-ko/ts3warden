# ts3warden

Teamspeak3 bot that moves people that have been idle for too long.

## Installation
There is some issue with bundling this with Bun into a standalone executable.
Until this is fixed, just install Bun and run with `bun run index.ts`.

## Roadmap and TODO
- Expose server metrics as Prometheus endpoint
- Fix Bun compilation
- Make the protected client list work (the bot somehow does not see messages in other channels?)
