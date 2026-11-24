// cobalt-vanguard controller — built by Muse (muse-spark-1.3) for battle.training Season 2.
// Strategy: hunter-style draft (missile + MBT + drone + scout). Drone spots from the air,
// missile carrier locks on through the data link and fires guided rounds from range,
// MBT brawls at a managed distance band, scout caps objectives and keeps its distance.
// Squad-wide focus fire on the weakest visible enemy, shots led by shell flight time,
// artillery-dodge, low-HP retreat, per-unit objective assignment with anti-clump offsets.

const FP = 65536;
const FULL = 4096;

let rules, map, side, hill, spawnPt;
const memory = new Map(); // enemy id -> {x,y,heading,speed,hpFrac,kind,tick}

function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) { return Math.round((Math.atan2(by - ay, bx - ax) / (2 * Math.PI)) * FULL) & (FULL - 1); }
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }
function passable(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  const t = map.terrain[ty * map.width + tx];
  return t !== 2 && t !== 4 && t !== 6;
}
function velOf(c) {
  const rad = (c.heading / FULL) * 2 * Math.PI;
  return [Math.cos(rad) * c.speed, Math.sin(rad) * c.speed];
}
function leadPoint(shooter, spec, c) {
  // predicted intercept point for a direct shell
  const d = dist(shooter.x, shooter.y, c.x, c.y);
  const shell = spec.gun.shellSpeed || FP * 2;
  const t = d / shell;
  const [vx, vy] = velOf(c);
  return [Math.round(c.x + vx * t), Math.round(c.y + vy * t)];
}

globalThis.controller = {
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    const pick = ["missile", "mbt", "drone", "scout"];
    const cost = pick.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && pick.every((k) => d.roster.includes(k)) ? pick : undefined;
  },

  hello(h) {
    rules = h.rules; map = h.map; side = h.side;
    hill = [Math.floor(map.width / 2) * FP + FP / 2, Math.floor(map.height / 2) * FP + FP / 2];
    const sp = map.spawns[side];
    spawnPt = [sp[0] * FP + FP / 2, sp[1] * FP + FP / 2];
    memory.clear();
  },

  tick(o) {
    const orders = [];
    // --- refresh contact memory ---
    const seenNow = new Set();
    for (const c of o.contacts) {
      seenNow.add(c.id);
      memory.set(c.id, { x: c.x, y: c.y, heading: c.heading, speed: c.speed, hpFrac: c.hpFrac, kind: c.kind, tick: o.tick });
    }
    for (const [id, m] of memory) if (o.tick - m.tick > 400) memory.delete(id);

    const alive = o.units.filter((u) => u.alive);
    // squad centroid
    let cx = 0, cy = 0;
    for (const u of alive) { cx += u.x; cy += u.y; }
    if (alive.length) { cx /= alive.length; cy /= alive.length; }

    // --- focus target: weakest visible contact (hpFrac), tie-break nearest to centroid ---
    let focus = null, focusScore = Infinity;
    for (const c of o.contacts) {
      const s = c.hpFrac * 2 + dist(cx, cy, c.x, c.y) / FP;
      if (s < focusScore) { focusScore = s; focus = c; }
    }

    // objectives not held by us, best first per position
    function bestObjective(x, y) {
      let best = null, bs = -1;
      for (const ob of o.objectives || []) {
        if (ob.owner === side && ob.state === "held") continue;
        const s = ob.weight / (1 + dist(x, y, ob.x, ob.y) / FP);
        if (s > bs) { bs = s; best = ob; }
      }
      return best ? [best.x, best.y] : null;
    }

    alive.forEach((u, idx) => {
      const spec = rules.units[u.kind];
      const order = { id: u.id };
      const myFocus = focus;
      const dFocus = myFocus ? dist(u.x, u.y, myFocus.x, myFocus.y) : Infinity;
      const hpFracMe = u.hp / u.maxHp;

      // --- artillery dodge: a shell lands near me soon -> move sideways, now ---
      let dodge = null;
      for (const s of o.incoming || []) {
        if (s.ticks <= 34 && dist(u.x, u.y, s.x, s.y) < 4.2 * FP) { dodge = s; break; }
      }

      // ---------- movement goal ----------
      let goal = null;
      let holdPosition = false;
      if (dodge) {
        const a = angleTo(dodge.x, dodge.y, u.x, u.y);
        const rad = (a / FULL) * 2 * Math.PI;
        goal = [u.x + Math.cos(rad) * 6 * FP, u.y + Math.sin(rad) * 6 * FP];
      } else if (u.kind === "drone") {
        // shadow the focus target from sensor edge, else sit over best objective
        if (myFocus) {
          const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
          const rad = (a / FULL) * 2 * Math.PI;
          const ring = 26 * FP;
          goal = [myFocus.x + Math.cos(rad) * ring, myFocus.y + Math.sin(rad) * ring];
          if (dFocus < 24 * FP) goal = [u.x + Math.cos(rad) * 8 * FP, u.y + Math.sin(rad) * 8 * FP]; // back off
        } else goal = bestObjective(u.x, u.y) || hill;
      } else if (u.kind === "scout") {
        if (myFocus && dFocus < 13 * FP) {
          const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
          const rad = (a / FULL) * 2 * Math.PI;
          goal = [u.x + Math.cos(rad) * 10 * FP, u.y + Math.sin(rad) * 10 * FP]; // flee, keep spotting
        } else goal = bestObjective(u.x, u.y) || (myFocus ? [myFocus.x, myFocus.y] : hill);
      } else if (u.kind === "missile") {
        if (u.ammo === 0) goal = spawnPt; // go home to resupply
        else if (myFocus) {
          const want = 30 * FP;
          if (dFocus > want + 3 * FP) goal = [myFocus.x, myFocus.y];
          else if (dFocus < 20 * FP) {
            const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
            const rad = (a / FULL) * 2 * Math.PI;
            goal = [u.x + Math.cos(rad) * 8 * FP, u.y + Math.sin(rad) * 8 * FP];
          } else holdPosition = true;
        } else goal = bestObjective(u.x, u.y) || hill;
      } else if (u.kind === "artillery") {
        if (u.ammo === 0) goal = spawnPt;
        else if (myFocus) {
          if (dFocus < spec.gun.minRange * 1.4) {
            const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
            const rad = (a / FULL) * 2 * Math.PI;
            goal = [u.x + Math.cos(rad) * 10 * FP, u.y + Math.sin(rad) * 10 * FP];
          } else if (dFocus > spec.gun.maxRange * 0.8) goal = [myFocus.x, myFocus.y];
          else holdPosition = true;
        } else goal = bestObjective(u.x, u.y) || hill;
      } else if (u.kind === "apc") {
        goal = bestObjective(u.x, u.y) || (myFocus ? [myFocus.x, myFocus.y] : hill);
      } else {
        // mbt (and any other gun platform): manage a distance band to the focus
        if (hpFracMe < 0.25 && myFocus && dFocus < spec.gun.maxRange) {
          goal = spawnPt; // battered: fall back, turret still fires
        } else if (myFocus && dFocus <= spec.gun.maxRange * 1.05) {
          const want = spec.gun.maxRange * 0.72;
          if (dFocus > want + 2.5 * FP) goal = [myFocus.x, myFocus.y];
          else if (dFocus < want - 4 * FP) {
            const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
            const rad = (a / FULL) * 2 * Math.PI;
            goal = [u.x + Math.cos(rad) * 7 * FP, u.y + Math.sin(rad) * 7 * FP];
          } else holdPosition = true; // in the band: sit and shoot
        } else goal = bestObjective(u.x, u.y) || (myFocus ? [myFocus.x, myFocus.y] : hill);
      }

      // anti-clump: lateral offset when several units share a goal area
      if (goal && alive.length > 1 && u.kind !== "drone") {
        const a = angleTo(u.x, u.y, goal[0], goal[1]);
        const perp = ((a + 1024) & (FULL - 1)) / FULL * 2 * Math.PI;
        const off = (idx - (alive.length - 1) / 2) * 2.2 * FP;
        goal = [goal[0] + Math.cos(perp) * off, goal[1] + Math.sin(perp) * off];
      }

      if (goal && o.canMove && !holdPosition) {
        const dGoal = dist(u.x, u.y, goal[0], goal[1]);
        if (dGoal > 1.2 * FP || u.kind === "drone") {
          let want = angleTo(u.x, u.y, goal[0], goal[1]);
          if (u.kind !== "drone") {
            const offsets = [0, 341, -341, 683, -683, 1024, -1024, 1536, -1536];
            for (const off of offsets) {
              const a = (want + off) & (FULL - 1);
              const rad = (a / FULL) * 2 * Math.PI;
              if (passable(u.x + Math.cos(rad) * FP * 1.6, u.y + Math.sin(rad) * FP * 1.6)) { want = a; break; }
            }
          }
          const d = angDiff(u.heading, want);
          order.steer = Math.max(-FP, Math.min(FP, Math.round((d / spec.turnRate) * FP)));
          order.throttle = Math.abs(d) > 640 ? Math.round(FP * 0.25) : FP;
          if (u.blocked && u.kind !== "drone") { order.throttle = -FP; order.steer = FP; }
        }
      }

      // ---------- weapons ----------
      if (u.kind === "missile") {
        if (myFocus) {
          order.target = myFocus.id; // keep the lock fed every tick
          if (u.lockTarget === myFocus.id && u.reload === 0 && u.ammo !== 0 &&
              dFocus >= spec.gun.minRange && dFocus <= spec.gun.maxRange) {
            order.fire = true;
          }
        }
      } else if (u.kind === "drone") {
        // no weapon
      } else if (spec.gun.mode === "indirect") {
        if (myFocus && u.reload === 0 && u.ammo !== 0 && dFocus >= spec.gun.minRange && dFocus <= spec.gun.maxRange) {
          // lead by shell flight time: 40 ticks + 1 tick per tile
          const tTicks = 40 + dFocus / FP;
          const [vx, vy] = velOf(myFocus);
          order.fire = [Math.round(myFocus.x + vx * tTicks), Math.round(myFocus.y + vy * tTicks)];
        } else if (myFocus && u.reload2 === 0 && dFocus <= (spec.secondary ? spec.secondary.maxRange : 0)) {
          order.fire = true; // MG if something is on top of us
        }
      } else if (spec.gun.mode === "direct" || spec.gun.mode === "none") {
        const gun = spec.gun.mode === "direct" ? spec.gun : spec.secondary;
        if (myFocus && gun) {
          const aim = leadPoint(u, { gun }, myFocus);
          order.aimAt = aim;
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, aim[0], aim[1]))) <= gun.aimTolerance + 20;
          const reloading = spec.gun.mode === "direct" ? u.reload : u.reload2;
          if (reloading === 0 && aimed && dFocus <= gun.maxRange) order.fire = true;
        }
      }

      orders.push(order);
    });

    return { units: orders };
  },
};
