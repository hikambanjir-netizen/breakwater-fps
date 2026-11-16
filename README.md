# Breakwater — a three.js tactical FPS

[![make.fun](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/hikambanjir-netizen/breakwater-fps/rank.svg)](https://make.fun/bounty/threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/hikambanjir-netizen/breakwater-fps/reward.svg)](https://make.fun/bounty/threejs-fps-02)

A round-based tactical first-person shooter in the style Counter-Strike made
famous, built for the make.fun `threejs-fps-02` bounty. Two teams fight over
a container port at dusk: the Tidebreakers attack, the Harbour Guard defend.

- **4v4, single-player vs bots** — you plus three bot teammates against four
  defending bots, on an original three-lane container-port map (West / Mid /
  East, two connectors).
- **Objective** — plant the Surge Charge at Crane Bay (A) or the Cold Store
  (B), or eliminate the other team. Defenders defuse; the charge can be
  dropped and recovered.
- **Economy** — $800 start, round-win/loss bonuses with a loss streak, kill /
  plant / defuse rewards; a buy menu with 5 guns, 3 grenades, armour and a
  defuse kit.
- **Gunplay where accuracy counts** — stop-and-burst spread, recoil bloom,
  crouching, headshots, movement and armour all matter.
- **Bots that play** — vision cones and line-of-sight (smoke blocks sight),
  hearing, shared intel, lane plans, post-plant holds, retakes and defuses.
- **Tech** — fixed-step DOM-free simulation (`game/src/sim.js`) apart from
  the three.js renderer (`game/src/view.js`), pooled effects, synthesised
  WebAudio sounds, no build step, no network. three.js 0.187.0 vendored.

## Play it

```sh
node serve.ts          # serves game/ on http://localhost:8080
```

Click **Deploy**, then play: WASD move, mouse look, click fire, R reload,
E plant/defuse (hold), B buy menu, 1/2/3 smoke/flash/frag, Ctrl crouch.

## Hand it in

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` copies `game/` and `screenshots/` to the output directory and
writes `dossier.json` with the kit's vendored make.fun library.

## License

MIT — see `LICENSE`.
