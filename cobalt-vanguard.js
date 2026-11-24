// cobalt-vanguard controller v2.3 — fixes from replay forensics (24 Nov 2026).
//
// v2.3 changes (from the live scrimmage vs blasius-tank on the exact loss seed):
//  G. HOLDERS DETOURING OFF THEIR OWN POINT: the stuck-detour check ran BEFORE
//     the goal was known, so a unit sitting still ON its objective (holding) was
//     judged "stuck" every 60 ticks and sent on a 100-tick sideways detour —
//     the objective flipped to empty ~10 times a game (~500 lost hold-ticks).
//     Fix: the detour check only arms when TRYING to reach an unreached goal.
//  H. ANCHOR OFFSETS: the anti-clump ±3.3-tile spread pushed anchor MBTs out of
//     the 5-tile scoring radius. Fix: MBTs driving to the primary objective get
//     no lateral offset.
//
// v1 loss causes (verified from ladder replays, not guesses):
//  A. OBJECTIVE ABANDONMENT: bestObjective() skipped objectives we already held, so the
//     whole squad marched to the far enemy objective, lost its own, turned back, and
//     spent the game in transit (blasius-tank: we held our w3 only ~2200/4521 ticks,
//     lost the race 6597-12588 with ZERO shots fired by either side).
//     Fix: ONE PRIMARY objective (heaviest, nearest our spawn) — the whole squad
//     converges on it and the MBT anchors it once held. No flip-flopping to the
//     enemy's objective. (v2.0 tried one anchor per held objective and SPLIT the
//     squad into 1v2/1v3 fights — worse locally, 59.4% vs v1's 71.9%.)
//  B. MISSILE LOCK SPAM: fire:true was sent every tick while the lock was still
//     building, producing 1853 "fire:lock" refusals in one game; focus switching
//     (weakest contact) kept restarting the 40-tick lock, so the missile fired twice.
//     Fix: STICKY missile target + fire only when u.lockTicks >= lockTicks, with a
//     120-tick abandon rule that switches to a slow, lockable target.
//  C. SCOUT FIXED GUN: aimAt does nothing for a fixed gun (engine: turret follows
//     the hull). The scout fired along whatever way its hull faced while fleeing:
//     88 shots, 0 damage vs nightscout. Fix: scout aims BY HULL — it closes
//     hull-first, then stops at a 16-tile ring and rotates in place to shoot.
//  D. MBT LONG-RANGE WASTE: 51 shots -> ~143 dmg (3 hits) firing at 25-30 tiles
//     at moving targets through terrain. Fix: hold fire beyond 22 tiles; close
//     to the 15-20 tile band first (movement range is NOT capped, only fire).
//  E. STUCK UNITS: scouts blocked for 2362/4782 ticks, MBTs spinning in place on
//     blocked-recovery (reverse + full steer = spin). Fix: stuck detection with
//     a sideways detour waypoint; blocked recovery reverses STRAIGHT, then resumes.
//  F. TRIPLE-MBT BRAWLS: in a straight DPS race 3 MBTs (480 HP, 3x45 dmg) wipe
//     our 1-MBT squad in ~86 s (orion-vanguard). Fix: don't take the brawl —
//     missile kites at 26-32 tiles with drone spotting, MBT anchors objectives.

const FP = 65536;
const FULL = 4096;

// DRAFT: "hunter" (missile+mbt+drone+scout) or "twin" (mbt+mbt+drone+drone).
// Flip this line to test the other draft; the logic below is draft-generic.
const DRAFT_PICK = ["mbt", "mbt", "drone", "drone"];

let rules, map, side, hill, spawnPt, primary = null;
const memory = new Map(); // enemy id -> {x,y,heading,speed,hpFrac,kind,tick}
let focusId = 0;          // sticky squad focus target id
let missileTargetId = 0;  // sticky missile lock target id
let missileTargetSeen = 0;
let missileTargetSetTick = 0; // tick the current missile target was chosen
const stuck = new Map();  // unit id -> {x, y, tick, detourUntil, detourX, detourY, revUntil}

function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) { return Math.round((Math.atan2(by - ay, bx - ax) / (2 * Math.PI)) * FULL) & (FULL - 1); }
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }
function passable(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  const t = map.terrain[ty * map.width + tx];
  return rules.terrainSpeed ? rules.terrainSpeed[t] > 0 : (t !== 2 && t !== 4 && t !== 6 && t !== 8);
}
function velOf(c) {
  const rad = (c.heading / FULL) * 2 * Math.PI;
  return [Math.cos(rad) * c.speed, Math.sin(rad) * c.speed];
}
function leadPoint(shooter, spec, c) {
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
    const cost = DRAFT_PICK.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && DRAFT_PICK.every((k) => d.roster.includes(k)) ? DRAFT_PICK.slice() : undefined;
  },

  hello(h) {
    rules = h.rules; map = h.map; side = h.side;
    hill = [Math.floor(map.width / 2) * FP + FP / 2, Math.floor(map.height / 2) * FP + FP / 2];
    const sp = map.spawns[side];
    spawnPt = [sp[0] * FP + FP / 2, sp[1] * FP + FP / 2];
    memory.clear(); focusId = 0; missileTargetId = 0; missileTargetSeen = 0; missileTargetSetTick = 0; stuck.clear();
    // FIX A: the primary objective — heaviest, tie-break nearest our spawn.
    // The whole squad converges on it; it never changes mid-game.
    primary = null;
    let bs = -1;
    for (const ob of h.objectives || []) {
      const s = ob.weight * 100 - dist(spawnPt[0], spawnPt[1], ob.x, ob.y) / FP;
      if (s > bs) { bs = s; primary = ob; }
    }
  },

  tick(o) {
    const orders = [];
    const seenNow = new Set();
    for (const c of o.contacts) {
      seenNow.add(c.id);
      memory.set(c.id, { x: c.x, y: c.y, heading: c.heading, speed: c.speed, hpFrac: c.hpFrac, kind: c.kind, tick: o.tick });
    }
    for (const [id, m] of memory) if (o.tick - m.tick > 400) memory.delete(id);

    const alive = o.units.filter((u) => u.alive);
    let cx = 0, cy = 0;
    for (const u of alive) { cx += u.x; cy += u.y; }
    if (alive.length) { cx /= alive.length; cy /= alive.length; }

    // --- sticky focus: keep current target while visible/fresh, else weakest visible ---
    let focus = null;
    if (focusId) {
      focus = o.contacts.find((c) => c.id === focusId) || null;
      if (!focus) {
        const m = memory.get(focusId);
        if (m && o.tick - m.tick <= 200) focus = { id: focusId, x: m.x, y: m.y, heading: m.heading, speed: m.speed, hpFrac: m.hpFrac, kind: m.kind };
        else focusId = 0;
      }
    }
    if (!focus) {
      let fs = Infinity;
      for (const c of o.contacts) {
        const s = c.hpFrac * 2 + dist(cx, cy, c.x, c.y) / FP;
        if (s < fs) { fs = s; focus = c; }
      }
      if (focus) focusId = focus.id;
    }

    // --- sticky missile target (FIX B): abandon after 120 ticks without a lock ---
    let mTarget = null;
    if (missileTargetId) {
      mTarget = o.contacts.find((c) => c.id === missileTargetId) || null;
      if (mTarget) missileTargetSeen = o.tick;
      else if (o.tick - missileTargetSeen > 120) missileTargetId = 0;
      else {
        const m = memory.get(missileTargetId);
        if (m) mTarget = { id: missileTargetId, x: m.x, y: m.y, heading: m.heading, speed: m.speed, hpFrac: m.hpFrac, kind: m.kind };
      }
      if (missileTargetId && o.tick - missileTargetSetTick > 120) {
        let best = null, bs = Infinity;
        for (const c of o.contacts) {
          const s = c.hpFrac * 2 + dist(cx, cy, c.x, c.y) / FP - (c.kind === "mbt" || c.kind === "apc" ? 3 : 0);
          if (s < bs) { bs = s; best = c; }
        }
        if (best && best.id !== missileTargetId) { missileTargetId = best.id; missileTargetSetTick = o.tick; missileTargetSeen = o.tick; mTarget = best; }
        else missileTargetSetTick = o.tick;
      }
    }
    if (!mTarget && focus) { missileTargetId = focus.id; missileTargetSetTick = o.tick; missileTargetSeen = o.tick; mTarget = focus; }

    // --- primary objective state + whether we are fighting near it ---
    const prim = primary ? (o.objectives || []).find((ob) => ob.x === primary.x && ob.y === primary.y) : null;
    const primHeld = prim && prim.owner === side && prim.state === "held";
    const primPos = prim ? [prim.x, prim.y] : hill;
    let fightNearPrim = false;
    if (focus && prim) fightNearPrim = dist(focus.x, focus.y, prim.x, prim.y) < 28 * FP;
    function bestUnheldFor(x, y) {
      let best = null, bs = -1;
      for (const ob of o.objectives || []) {
        if (ob.owner === side && ob.state === "held") continue;
        const s = ob.weight / (1 + dist(x, y, ob.x, ob.y) / FP);
        if (s > bs) { bs = s; best = ob; }
      }
      return best;
    }

    alive.forEach((u, idx) => {
      const spec = rules.units[u.kind];
      const order = { id: u.id };
      const myFocus = focus;
      const dFocus = myFocus ? dist(u.x, u.y, myFocus.x, myFocus.y) : Infinity;
      const hpFracMe = u.hp / u.maxHp;

      // --- artillery dodge ---
      let dodge = null;
      for (const s of o.incoming || []) {
        if (s.ticks <= 34 && dist(u.x, u.y, s.x, s.y) < 4.2 * FP) { dodge = s; break; }
      }

      // --- stuck state (FIX E, v2.3): the detour check runs AFTER the goal is
      // known (see below) — a unit sitting still ON its objective is holding,
      // not stuck. The old pre-goal check detoured holders off their own point.
      let st = stuck.get(u.id);
      if (!st) { st = { x: u.x, y: u.y, tick: o.tick, detourUntil: 0, detourX: 0, detourY: 0, revUntil: 0 }; stuck.set(u.id, st); }
      const inDetour = o.tick < st.detourUntil;

      // ---------- movement goal ----------
      let goal = null;
      let holdPosition = false;
      if (dodge) {
        const a = angleTo(dodge.x, dodge.y, u.x, u.y);
        const rad = (a / FULL) * 2 * Math.PI;
        goal = [u.x + Math.cos(rad) * 6 * FP, u.y + Math.sin(rad) * 6 * FP];
      } else if (inDetour) {
        goal = [st.detourX, st.detourY];
      } else if (u.kind === "drone") {
        // FIX (v2.1): flee ANY enemy within 15 tiles — the drone is the spotter.
        let nearestFoe = null, nearestD = Infinity;
        for (const c of o.contacts) {
          const d = dist(u.x, u.y, c.x, c.y);
          if (d < nearestD) { nearestD = d; nearestFoe = c; }
        }
        if (nearestFoe && nearestD < 15 * FP) {
          const a = angleTo(nearestFoe.x, nearestFoe.y, u.x, u.y);
          const rad = (a / FULL) * 2 * Math.PI;
          goal = [u.x + Math.cos(rad) * 10 * FP, u.y + Math.sin(rad) * 10 * FP];
        } else if (myFocus) {
          const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
          const rad = (a / FULL) * 2 * Math.PI;
          const ring = 26 * FP;
          goal = [myFocus.x + Math.cos(rad) * ring, myFocus.y + Math.sin(rad) * ring];
          if (dFocus < 24 * FP) goal = [u.x + Math.cos(rad) * 8 * FP, u.y + Math.sin(rad) * 8 * FP];
        } else goal = primPos;
      } else if (u.kind === "scout") {
        // FIX C: hull-aim — close hull-first, stop at a 16-tile ring, rotate in place.
        // Only splits off to contest a second objective when the primary is held
        // and no fight is happening near it (squad stays together otherwise).
        if (myFocus && hpFracMe < 0.3) {
          const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
          const rad = (a / FULL) * 2 * Math.PI;
          goal = [u.x + Math.cos(rad) * 10 * FP, u.y + Math.sin(rad) * 10 * FP];
        } else if (myFocus && dFocus > 16 * FP) {
          goal = [myFocus.x, myFocus.y];
        } else if (myFocus && dFocus <= 16 * FP) {
          holdPosition = true; // rotate-in-place branch below aims the hull
        } else if (primHeld && !fightNearPrim) {
          const ob = bestUnheldFor(u.x, u.y);
          goal = ob ? [ob.x, ob.y] : primPos;
        } else goal = primPos;
      } else if (u.kind === "missile") {
        if (u.ammo === 0) goal = spawnPt;
        else if (mTarget) {
          // FIX F: kite at 26-32 tiles; never chase across the map
          const want = 29 * FP;
          if (dFocus > want + 4 * FP) {
            const dSpawn = dist(mTarget.x, mTarget.y, spawnPt[0], spawnPt[1]);
            if (dSpawn < 55 * FP) goal = [mTarget.x, mTarget.y];
            else goal = primPos;
          } else if (dFocus < 22 * FP) {
            const a = angleTo(mTarget.x, mTarget.y, u.x, u.y);
            const rad = (a / FULL) * 2 * Math.PI;
            goal = [u.x + Math.cos(rad) * 8 * FP, u.y + Math.sin(rad) * 8 * FP];
          } else holdPosition = true;
        } else goal = primPos;
      } else if (u.kind === "artillery") {
        if (u.ammo === 0) goal = spawnPt;
        else if (myFocus) {
          if (dFocus < spec.gun.minRange * 1.4) {
            const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
            const rad = (a / FULL) * 2 * Math.PI;
            goal = [u.x + Math.cos(rad) * 10 * FP, u.y + Math.sin(rad) * 10 * FP];
          } else if (dFocus > spec.gun.maxRange * 0.8) goal = [myFocus.x, myFocus.y];
          else holdPosition = true;
        } else goal = primPos;
      } else if (u.kind === "apc") {
        goal = primPos;
      } else {
        // mbt (and other gun platforms): anchor the primary once held, else
        // fight in the 15-20 tile band; close to the focus whenever it is in
        // gun range (only FIRE is capped at 22 tiles — FIX D).
        if (primHeld && u.kind === "mbt") {
          const r = (prim ? prim.radius : 6 * FP) || 6 * FP;
          const d = dist(u.x, u.y, primPos[0], primPos[1]);
          if (d < r * 0.55) {
            if (hpFracMe < 0.25) {
              const a = angleTo(spawnPt[0], spawnPt[1], primPos[0], primPos[1]);
              const rad = (a / FULL) * 2 * Math.PI;
              goal = [primPos[0] + Math.cos(rad) * 8 * FP, primPos[1] + Math.sin(rad) * 8 * FP];
            } else holdPosition = true; // anchor: sit on the point, turret fights
          } else goal = primPos;
        } else if (hpFracMe < 0.25 && myFocus && dFocus < spec.gun.maxRange) {
          goal = spawnPt;
        } else if (myFocus && dFocus <= spec.gun.maxRange) {
          const want = spec.gun.maxRange * 0.6;
          if (dFocus > want + 2.5 * FP) goal = [myFocus.x, myFocus.y];
          else if (dFocus < want - 4 * FP) {
            const a = angleTo(myFocus.x, myFocus.y, u.x, u.y);
            const rad = (a / FULL) * 2 * Math.PI;
            goal = [u.x + Math.cos(rad) * 7 * FP, u.y + Math.sin(rad) * 7 * FP];
          } else holdPosition = true;
        } else goal = primPos;
      }

      // --- stuck check (FIX E, v2.3): only when TRYING to reach an unreached
      // goal. Sitting on the objective (holdPosition / arrived) never detours.
      if (goal && !holdPosition) {
        const dGoal0 = dist(u.x, u.y, goal[0], goal[1]);
        if (dGoal0 > 1.2 * FP) {
          if (o.tick - st.tick >= 60) {
            const moved = dist(u.x, u.y, st.x, st.y);
            if (moved < 0.5 * FP && o.tick >= st.detourUntil) {
              const a = angleTo(u.x, u.y, goal[0], goal[1]) + 1024;
              const rad = (a / FULL) * 2 * Math.PI;
              st.detourX = u.x + Math.cos(rad) * 10 * FP;
              st.detourY = u.y + Math.sin(rad) * 10 * FP;
              st.detourUntil = o.tick + 100;
            }
            st.x = u.x; st.y = u.y; st.tick = o.tick;
          }
        } else { st.x = u.x; st.y = u.y; st.tick = o.tick; }
      } else { st.x = u.x; st.y = u.y; st.tick = o.tick; }

      // anti-clump: lateral offset when several units share a goal area.
      // FIX (v2.3): an MBT driving to the primary objective gets NO offset —
      // the ±3.3-tile spread pushed anchors out of the 5-tile scoring radius.
      const mbtToPrim = u.kind === "mbt" && goal && dist(goal[0], goal[1], primPos[0], primPos[1]) < 8 * FP;
      if (goal && alive.length > 1 && u.kind !== "drone" && !holdPosition && !mbtToPrim) {
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
          // FIX E: blocked -> reverse STRAIGHT briefly, not spin in place
          if (u.blocked && u.kind !== "drone") {
            if (o.tick >= st.revUntil) st.revUntil = o.tick + 12;
            order.throttle = -FP; order.steer = 0;
          }
        }
      } else if (u.kind === "scout" && myFocus && holdPosition) {
        // scout holding position with a target: rotate hull toward it in place
        const want = angleTo(u.x, u.y, myFocus.x, myFocus.y);
        const d = angDiff(u.heading, want);
        if (Math.abs(d) > 40) {
          order.steer = Math.max(-FP, Math.min(FP, Math.round((d / spec.turnRate) * FP)));
          order.throttle = 0;
        }
      }

      // ---------- weapons ----------
      if (u.kind === "missile") {
        if (mTarget) {
          order.target = mTarget.id; // keep the lock fed every tick
          // FIX B: fire only when the lock is actually complete
          const locked = u.lockTarget === mTarget.id && u.lockTicks >= (spec.gun.lockTicks || 40);
          if (locked && u.reload === 0 && u.ammo !== 0 &&
              dFocus >= spec.gun.minRange && dFocus <= spec.gun.maxRange) {
            order.fire = true;
          }
        }
      } else if (u.kind === "drone") {
        // no weapon
      } else if (spec.gun.mode === "indirect") {
        if (myFocus && u.reload === 0 && u.ammo !== 0 && dFocus >= spec.gun.minRange && dFocus <= spec.gun.maxRange) {
          const tTicks = 40 + dFocus / FP;
          const [vx, vy] = velOf(myFocus);
          order.fire = [Math.round(myFocus.x + vx * tTicks), Math.round(myFocus.y + vy * tTicks)];
        } else if (myFocus && u.reload2 === 0 && dFocus <= (spec.secondary ? spec.secondary.maxRange : 0)) {
          order.fire = true;
        }
      } else if (spec.gun.mode === "direct" || spec.gun.mode === "none") {
        const gun = spec.gun.mode === "direct" ? spec.gun : spec.secondary;
        if (myFocus && gun) {
          if (u.kind === "scout") {
            // FIX C: fixed gun — only fire when the HULL already points at the target
            const bearing = angleTo(u.x, u.y, myFocus.x, myFocus.y);
            const aimed = Math.abs(angDiff(u.heading, bearing)) <= gun.aimTolerance + 20;
            const reloading = u.reload;
            if (reloading === 0 && aimed && dFocus <= gun.maxRange) order.fire = true;
          } else {
            const aim = leadPoint(u, { gun }, myFocus);
            order.aimAt = aim;
            const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, aim[0], aim[1]))) <= gun.aimTolerance + 20;
            const reloading = spec.gun.mode === "direct" ? u.reload : u.reload2;
            // FIX D: MBT holds fire beyond 22 tiles (long-range shots almost never land)
            const maxFireRange = u.kind === "mbt" ? Math.min(gun.maxRange, 22 * FP) : gun.maxRange;
            if (reloading === 0 && aimed && dFocus <= maxFireRange) order.fire = true;
          }
        }
      }

      orders.push(order);
    });

    return { units: orders };
  },
};
